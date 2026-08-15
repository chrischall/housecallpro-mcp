/** Liveness: is the consumer API reachable, and is a link configured and usable? */
import { messageOf, textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HousecallProClient } from '../client.js';
import { VERSION } from '../version.js';

export function registerHealthcheckTools(server: McpServer, client: HousecallProClient): void {
  server.registerTool(
    'housecallpro_healthcheck',
    {
      description:
        'Check that this server can reach Housecall Pro and that a configured customer ' +
        'link still resolves. Run this first when a tool fails.',
      annotations: toolAnnotations({ title: 'Healthcheck', openWorld: true }),
      inputSchema: {},
    },
    async () => {
      const links = client.links.list();
      const result: Record<string, unknown> = {
        version: VERSION,
        transport: 'direct https (no browser bridge required)',
        api_origin: 'https://app.housecallpro.com',
        links_configured: links.length,
        links,
      };

      // An empty registry means either nothing was set or what was set did not
      // parse. Those need different fixes, and reporting a malformed link as
      // "no link configured" hides the parse error that says why.
      const problem = client.links.problem;
      if (problem) {
        result['status'] = problem === 'invalid' ? 'bad_link' : 'no_link_configured';
        if (problem === 'invalid') result['error'] = client.links.problemDetail;
        result['hint'] =
          'Set HOUSECALLPRO_LINK to the estimate or invoice link your pro sent you.';
        return textResult(result);
      }

      try {
        // Probe the endpoint the configured link actually addresses. Always
        // calling getEstimate() reported `error` for a perfectly healthy
        // invoice-only setup — and threw on the shape check before making any
        // request, so it did not verify reachability either.
        if (await client.isInvoiceLink()) {
          const invoice = await client.getInvoice();
          result['status'] = 'ok';
          result['invoice_number'] = invoice['invoice_number'];
        } else {
          const estimate = await client.getEstimate();
          result['status'] = 'ok';
          result['estimate_number'] = estimate.estimate?.data?.['estimate_number'];
        }
      } catch (err) {
        result['status'] = 'error';
        result['error'] = messageOf(err);
      }
      return textResult(result);
    },
  );
}
