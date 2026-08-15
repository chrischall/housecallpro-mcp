/**
 * Estimate tools.
 *
 * Reads are plain. The one mutation — decline — is confirm-gated: without
 * `confirm: true` it makes no network call and returns a preview of exactly
 * what would be sent.
 */
import { schemaConfirm, textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HousecallProClient } from '../client.js';
import { summarizeEstimate, summarizeInvoice } from '../normalize.js';

const linkArg = z
  .string()
  .optional()
  .describe('Which configured link to use. Omit when only one is configured.');

export function registerEstimateTools(server: McpServer, client: HousecallProClient): void {
  server.registerTool(
    'housecallpro_get_estimate',
    {
      description:
        'Read an estimate a Housecall Pro contractor sent you: line items, totals, tax, ' +
        'the company behind it, and whether it is still awaiting your approval. ' +
        'Money is returned both as integer cents (`*_cents`, verbatim from the API) and ' +
        'as dollars (`*_usd`).',
      annotations: toolAnnotations({ title: 'Get estimate', openWorld: true }),
      inputSchema: {
        link: linkArg,
        raw: z
          .boolean()
          .optional()
          .describe(
            'Return the full upstream document instead of the summary. Much larger, and ' +
              'mostly display flags.',
          ),
      },
    },
    async ({ link, raw }) => {
      const estimate = await client.getEstimate(link);
      return textResult(raw ? estimate : summarizeEstimate(estimate));
    },
  );

  server.registerTool(
    'housecallpro_get_invoice',
    {
      description:
        'Read an invoice a Housecall Pro contractor sent you: amount, subtotal, tax, what ' +
        'is still owed, and whether it can be paid online. Money is returned both as ' +
        'integer cents (`*_cents`) and dollars (`*_usd`). Note this document carries no ' +
        'line items — the portal shows a summary only.',
      annotations: toolAnnotations({ title: 'Get invoice', openWorld: true }),
      inputSchema: {
        link: linkArg,
        raw: z
          .boolean()
          .optional()
          .describe('Return the full upstream document instead of the summary.'),
      },
    },
    async ({ link, raw }) => {
      const invoice = await client.getInvoice(link);
      return textResult(raw ? invoice : summarizeInvoice(invoice));
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
    async () => textResult({ links: client.links.list() }),
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
    async ({ organization_id }) => textResult(await client.getOrganization(organization_id)),
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
        return textResult({
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

      return textResult({
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
