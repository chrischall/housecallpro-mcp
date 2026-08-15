import { describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { HousecallProClient } from '../src/client.js';
import { LinkRegistry } from '../src/links.js';
import { registerEstimateTools } from '../src/tools/estimates.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

const TOKEN = `${'a'.repeat(64)}_${'b'.repeat(64)}`;

const ESTIMATE = {
  object: 'customer_estimate',
  estimate: { object: 'customer_estimate', data: { estimate_number: '900000001' } },
  options: {
    object: 'list',
    data: [{ object: 'option', id: 'est_1', status: 'Awaiting Approval', approval_date: null, total_amount: 34639 }],
  },
};

function harnessWith(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { HOUSECALLPRO_LINK: TOKEN }) {
  const client = new HousecallProClient(new LinkRegistry(env), { fetchImpl });
  return createTestHarness((server) => {
    registerEstimateTools(server, client);
    registerHealthcheckTools(server, client);
  });
}

function json(body: unknown, status = 200) {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('tool roster', () => {
  it('registers exactly the expected tools', async () => {
    const h = await harnessWith(json(ESTIMATE) as unknown as typeof fetch);
    const names = (await h.listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      'housecallpro_approve_estimate',
      'housecallpro_decline_estimate',
      'housecallpro_get_company',
      'housecallpro_get_estimate',
      'housecallpro_get_invoice',
      'housecallpro_healthcheck',
      'housecallpro_list_links',
    ]);
  });
});

describe('housecallpro_decline_estimate', () => {
  it('previews and makes no network call without confirm', async () => {
    let calls = 0;
    const fetchImpl = (() => { calls++; return json(ESTIMATE)(); }) as unknown as typeof fetch;
    const h = await harnessWith(fetchImpl);

    const out = parseToolResult(await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] }));

    expect(out).toMatchObject({ dry_run: true });
    expect(out.would_send).toMatchObject({ estimate_option_uuids: ['est_1'] });
    expect(calls).toBe(0);
  });

  it('declines and reports the state read back afterwards', async () => {
    const declined = structuredClone(ESTIMATE);
    (declined.options.data[0] as Record<string, unknown>)['status'] = 'Declined';
    let n = 0;
    const fetchImpl = (() => {
      n++;
      return json(n === 1 ? { ok: true } : declined)();
    }) as unknown as typeof fetch;

    const h = await harnessWith(fetchImpl);
    const out = parseToolResult(
      await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'], confirm: true }),
    );

    expect(out.verified_from_reread).toEqual([{ id: 'est_1', status: 'Declined', approval_date: null }]);
    expect(out.awaiting_approval).toBe(false);
  });
});

describe('housecallpro_approve_estimate', () => {
  it('always refuses, explaining why, without echoing the token', async () => {
    const h = await harnessWith(json(ESTIMATE) as unknown as typeof fetch);
    const res = await h.callTool('housecallpro_approve_estimate', { option_ids: ['est_1'] });
    const text = JSON.stringify(res);
    expect(text).toMatch(/reCAPTCHA/i);
    expect(text).not.toContain(TOKEN);
  });
});

describe('housecallpro_healthcheck', () => {
  it('reports no_link_configured rather than failing when unconfigured', async () => {
    const h = await harnessWith(json(ESTIMATE) as unknown as typeof fetch, {});
    const out = parseToolResult(await h.callTool('housecallpro_healthcheck', {}));
    expect(out.status).toBe('no_link_configured');
    expect(out.links_configured).toBe(0);
  });

  it('reports ok when a link resolves', async () => {
    const h = await harnessWith(json(ESTIMATE) as unknown as typeof fetch);
    const out = parseToolResult(await h.callTool('housecallpro_healthcheck', {}));
    expect(out.status).toBe('ok');
    expect(out.estimate_number).toBe('900000001');
  });
});
