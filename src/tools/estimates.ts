/**
 * Estimate tools.
 *
 * Reads are plain. The one mutation — decline — is confirm-gated: without
 * `confirm: true` it makes no network call and returns a preview of exactly
 * what would be sent.
 */
import {
  minifiedResult,
  resolveView,
  schemaConfirm,
  toolAnnotations,
  viewParam,
  viewResult,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HousecallProClient } from '../client.js';
import { HCP_VIEWS, summarizeEstimate, viewEstimate, viewInvoice } from '../normalize.js';

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
      inputSchema: {
        link: linkArg,
        view: estimateViewArg,
      },
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
      inputSchema: {
        link: linkArg,
        view: invoiceViewArg,
      },
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
      inputSchema: {},
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
      inputSchema: {
        organization_id: z
          .string()
          .describe('Organization UUID, from an estimate\'s `organization_id` field.'),
      },
    },
    async ({ organization_id }) => minifiedResult(await client.getOrganization(organization_id)),
  );

  server.registerTool(
    'housecallpro_decline_estimate',
    {
      description:
        'Decline one or more options on an estimate. Requires confirm:true — without it ' +
        'this returns a dry-run preview and makes no network call. Declining tells the ' +
        'contractor you are not proceeding; it cannot be undone from here.',
      annotations: toolAnnotations({ title: 'Decline estimate', readOnly: false, openWorld: true }),
      inputSchema: {
        link: linkArg,
        option_ids: z
          .array(z.string())
          .min(1)
          .describe('Estimate option ids to decline, from `options[].id` (e.g. `est_…`).'),
        confirm: schemaConfirm,
      },
    },
    async ({ link, option_ids, confirm }) => {
      if (!confirm) {
        return minifiedResult({
          dry_run: true,
          would_send: {
            method: 'POST',
            path: '/api/estimates/estimate_options/customer_declines',
            estimate_option_uuids: option_ids,
          },
          effect: 'Marks these estimate options as declined for the contractor.',
          note: 'Re-run with confirm: true to actually decline.',
        });
      }

      await client.declineOptions(option_ids, link);

      // A 2xx is not proof. Re-read and report the option's real state so a
      // silently-ignored write cannot be reported as success.
      const after = summarizeEstimate(await client.getEstimate(link));
      const touched = after.options.filter((o) => o.id && option_ids.includes(o.id));

      return minifiedResult({
        declined: option_ids,
        verified_from_reread: touched.map((o) => ({
          id: o.id,
          status: o.status,
          approval_date: o.approval_date,
        })),
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
      inputSchema: { link: linkArg, option_ids: z.array(z.string()).default([]) },
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
