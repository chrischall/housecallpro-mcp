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

      if (links.length === 0) {
        result['status'] = 'no_link_configured';
        result['hint'] =
          'Set HOUSECALLPRO_LINK to the estimate or invoice link your pro sent you.';
        return textResult(result);
      }

      try {
        const estimate = await client.getEstimate();
        result['status'] = 'ok';
        result['estimate_number'] = estimate.estimate?.data?.['estimate_number'];
      } catch (err) {
        result['status'] = 'error';
        result['error'] = messageOf(err);
      }
      return textResult(result);
    },
  );
}
