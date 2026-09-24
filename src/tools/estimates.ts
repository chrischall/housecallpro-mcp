/**
 * Estimate tools.
 *
 * Reads are plain. The one mutation — decline — asks the user first: a
 * confirmation prompt where the client supports one; otherwise the first call
 * posts nothing and returns a preview plus a confirmToken, and only a repeat
 * call with that token declines (see MCP_CONFIRM_MODE).
 */
import {
  confirmationFromEnv,
  confirmTokenParam,
  McpToolError,
  minifiedResult,
  requireConfirmationWithFallback,
  resolveView,
  toolAnnotations,
  viewParam,
  viewResult,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HousecallProClient } from '../client.js';
import {
  type EstimateOptionSummary,
  HCP_VIEWS,
  summarizeEstimate,
  viewEstimate,
  viewInvoice,
} from '../normalize.js';

/** Declined, or approved (an approval date is set): no longer open to decline. */
function isDecided(o: EstimateOptionSummary): boolean {
  return o.status === 'Declined' || o.approval_date != null;
}

const linkArg = z
  .string()
  .optional()
  .describe(
    'The Housecall Pro link your contractor sent you — paste it directly ' +
      '(pro.housecallpro.com/mobile_estimate/… or /mobile_invoice/…, or a ' +
      'client.housecallpro.com/estimates/… or /invoices/… URL), or the retrieval token ' +
      'from the end of it. Alternatively the label of a link configured in ' +
      'HOUSECALLPRO_LINKS. Omit only when exactly one link is configured.',
  );

/**
 * The `view` parameter, per document kind.
 *
 * Two rungs, not three — see `HCP_VIEWS`. The note is where each tool says what
 * ITS compact rung leaves out; the generic blurb only says that a projection
 * happened. Money gets a sentence of its own because the rungs disagree about
 * it: compact emits `*_cents` AND `*_usd`, while raw is the upstream document,
 * whose money is integer cents with no dollar sibling at all.
 */
const estimateViewArg = viewParam(HCP_VIEWS, {
  note:
    '"compact" is the summary: line items, totals, tax, company and approval state, with ' +
    'every money field as both `*_cents` and `*_usd`. "raw" is the upstream document ' +
    '(~4.8 KB, mostly display flags and `{object, data}` wrappers) — its money is integer ' +
    'CENTS with no dollar sibling, so `total_amount: 34639` means $346.39.',
});

const invoiceViewArg = viewParam(HCP_VIEWS, {
  note:
    '"compact" is the summary: totals, balance due, payability and the company, with every ' +
    'money field as both `*_cents` and `*_usd`, plus the `tax_cents`/`tax_usd` and `is_paid` ' +
    'this server derives. "raw" is the upstream document — it carries neither, and its ' +
    'money is integer CENTS with no dollar sibling.',
});

export function registerEstimateTools(server: McpServer, client: HousecallProClient): void {
  server.registerTool(
    'housecallpro_get_estimate',
    {
      description:
        'Read an estimate a Housecall Pro contractor sent you: line items, totals, tax, ' +
        'the company behind it, and whether it is still awaiting your approval. ' +
        'The default `compact` view returns money both as integer cents (`*_cents`, ' +
        'verbatim from the API) and as dollars (`*_usd`); `view: "raw"` returns the ' +
        'upstream document, whose money is cents only.',
      annotations: toolAnnotations({ title: 'Get estimate', openWorld: true }),
      inputSchema: z.object({
        link: linkArg,
        view: estimateViewArg,
      }),
    },
    // `view` is destructured OUT here, and only `link` reaches the client. A
    // handler written as `async (args) => client.getEstimate(args)` would put
    // `view=compact` on the wire as a query parameter.
    async ({ link, view }) => {
      const rung = resolveView(view, HCP_VIEWS);
      return viewResult(rung, viewEstimate(rung, await client.getEstimate(link)));
    },
  );

  server.registerTool(
    'housecallpro_get_invoice',
    {
      description:
        'Read an invoice a Housecall Pro contractor sent you: amount, subtotal, tax, what ' +
        'is still owed, and whether it can be paid online. The default `compact` view ' +
        'returns money both as integer cents (`*_cents`) and dollars (`*_usd`). Note this ' +
        'document carries no line items — the portal shows a summary only.',
      annotations: toolAnnotations({ title: 'Get invoice', openWorld: true }),
      inputSchema: z.object({
        link: linkArg,
        view: invoiceViewArg,
      }),
    },
    async ({ link, view }) => {
      const rung = resolveView(view, HCP_VIEWS);
      return viewResult(rung, viewInvoice(rung, await client.getInvoice(link)));
    },
  );

  server.registerTool(
    'housecallpro_list_links',
    {
      description:
        'List the Housecall Pro customer links this server is configured with. Labels and ' +
        'document kinds only — retrieval tokens are credentials and are never returned.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({}),
    },
    async () => minifiedResult({ links: client.links.list() }),
  );

  server.registerTool(
    'housecallpro_get_company',
    {
      description:
        'Look up the contractor behind an estimate: phone, email, website, address and ' +
        'default arrival window. Takes the `organization_id` from an estimate.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        organization_id: z
          .string()
          .describe("Organization UUID, from an estimate's `organization_id` field."),
      }),
    },
    async ({ organization_id }) => minifiedResult(await client.getOrganization(organization_id)),
  );

  server.registerTool(
    'housecallpro_decline_estimate',
    {
      description:
        'Decline one or more options on an estimate. Asks the user to confirm first: a ' +
        'confirmation prompt where the client supports one; otherwise the first call posts ' +
        'nothing and returns a preview and a confirmToken, and only a repeat call with that ' +
        'token proceeds (see MCP_CONFIRM_MODE). Declining tells the contractor you are not ' +
        'proceeding; it cannot be undone from here.',
      annotations: toolAnnotations({
        title: 'Decline estimate',
        readOnly: false,
        openWorld: true,
        destructive: true,
      }),
      inputSchema: z.object({
        link: linkArg,
        option_ids: z
          .array(z.string())
          .min(1)
          .describe('Estimate option ids to decline, from `options[].id` (e.g. `est_…`).'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ link, option_ids, confirmToken }, ctx) => {
      // Check the ids against the estimate BEFORE the irreversible write: an id
      // from another estimate, or an option already decided, must not be posted
      // and then reported back as "declined". This read runs on every call, so
      // the preview shows the options' current state and a token issued for one
      // state is refused (DRAFT_CHANGED) once the estimate has moved.
      const before = summarizeEstimate(await client.getEstimate(link));
      const byId = new Map(before.options.filter((o) => o.id).map((o) => [o.id!, o]));
      const unknown = option_ids.filter((id) => !byId.has(id));
      const decided = option_ids
        .map((id) => byId.get(id))
        .filter((o): o is EstimateOptionSummary => o !== undefined && isDecided(o));
      if (unknown.length > 0 || decided.length > 0) {
        const problems: string[] = [];
        if (unknown.length > 0) {
          problems.push(
            `not options on this estimate: ${unknown.join(', ')} ` +
              '(read it with housecallpro_get_estimate for its `options[].id`)',
          );
        }
        if (decided.length > 0) {
          problems.push(
            `already decided: ${decided.map((o) => `${o.id} (${o.status ?? 'approved'})`).join(', ')}`,
          );
        }
        throw new McpToolError(`Nothing was declined — ${problems.join('; ')}.`);
      }

      const wouldSend = {
        method: 'POST',
        path: '/api/estimates/estimate_options/customer_declines',
        estimate_option_uuids: option_ids,
      };
      const options = option_ids.map((id) => {
        const o = byId.get(id)!;
        return { id, status: o.status, approval_date: o.approval_date, total_amount_usd: o.total_amount_usd };
      });
      const gate = await requireConfirmationWithFallback(
        ctx,
        confirmationFromEnv({
          action: 'estimate.decline',
          message: 'Review and confirm declining these estimate options:',
          details: { estimate_number: before.estimate_number, options },
          tool: 'housecallpro_decline_estimate',
          confirmToken,
          subject: () => ({
            // Never the link: the retrieval token is a bearer credential, and a
            // confirm token's claims are readable. The estimate's identity and
            // the options' current state are bound through the payload instead.
            target: '',
            payload: {
              ...wouldSend,
              estimate_uuid: before.estimate_uuid,
              estimate_number: before.estimate_number,
              options: option_ids.map((id) => byId.get(id)),
            },
            preview: {
              would_send: wouldSend,
              effect: 'Marks these estimate options as declined for the contractor.',
              estimate_number: before.estimate_number,
              options,
            },
          }),
        }),
      );
      if (gate) return gate;

      await client.declineOptions(option_ids, link);

      // A 2xx is not proof. Re-read, and call an option declined only when the
      // re-read says so, so a silently-ignored write cannot be reported as success.
      const after = summarizeEstimate(await client.getEstimate(link));
      const touched = after.options.filter((o) => o.id && option_ids.includes(o.id));
      const reread = touched.map((o) => ({ id: o.id, status: o.status, approval_date: o.approval_date }));
      const confirmed = option_ids.filter((id) => touched.some((o) => o.id === id && o.status === 'Declined'));
      const notConfirmed = option_ids
        .filter((id) => !confirmed.includes(id))
        .map((id) => reread.find((o) => o.id === id) ?? { id, status: 'missing from re-read', approval_date: null });

      if (confirmed.length === 0) {
        throw new McpToolError(
          'The decline request was accepted, but re-reading the estimate shows none of these ' +
            `options declined: ${JSON.stringify(notConfirmed)}. ` +
            'Do not tell the user they were declined; check the estimate in a browser.',
        );
      }

      return minifiedResult({
        declined: confirmed,
        ...(notConfirmed.length > 0 && {
          not_confirmed: notConfirmed,
          warning:
            'The re-read does not show these options as declined. Do not report them as declined.',
        }),
        verified_from_reread: reread,
        awaiting_approval: after.awaiting_approval,
      });
    },
  );

  server.registerTool(
    'housecallpro_approve_estimate',
    {
      description:
        'Approving an estimate is NOT automatable and this tool always refuses. Housecall ' +
        'Pro gates approval behind a reCAPTCHA token only the real page can mint. Use this ' +
        'to get the explanation and the link to approve in a browser.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({
        link: linkArg,
        option_ids: z.array(z.string()).default([]),
      }),
    },
    async ({ link, option_ids }) => {
      // Deliberately does NOT echo the retrieval token, even though it would
      // make a clickable URL: the token is a bearer credential and tool results
      // travel further than this process. The user already has the link.
      // approveOptions returns Promise<never> — it always throws — so returning
      // it directly keeps this handler free of an unreachable trailing branch.
      return client.approveOptions(option_ids, link);
    },
  );
}
