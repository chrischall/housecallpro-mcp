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

  /**
   * A fetch that serves the estimate for GETs and `{ ok: true }` for the
   * decline POST, recording every call. `afterPost` is the estimate the
   * re-read sees once the POST has been made.
   */
  function scripted(before: unknown, afterPost: unknown) {
    const calls: Array<{ method: string; url: string }> = [];
    let posted = false;
    const fetchImpl = ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(url) });
      if (method === 'POST') {
        posted = true;
        return json({ ok: true })();
      }
      return json(posted ? afterPost : before)();
    }) as unknown as typeof fetch;
    return { fetchImpl, calls, posts: () => calls.filter((c) => c.method === 'POST').length };
  }

  function withOptions(...options: Array<Record<string, unknown>>) {
    const e = structuredClone(ESTIMATE);
    e.options.data = options.map((o) => ({ object: 'option', status: 'Awaiting Approval', approval_date: null, ...o })) as typeof e.options.data;
    return e;
  }

  it('declines and reports the state read back afterwards', async () => {
    const declined = withOptions({ id: 'est_1', status: 'Declined' });
    const s = scripted(ESTIMATE, declined);

    const h = await harnessWith(s.fetchImpl);
    const out = parseToolResult(
      await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'], confirm: true }),
    );

    expect(s.posts()).toBe(1);
    expect(out.declined).toEqual(['est_1']);
    expect(out.not_confirmed).toBeUndefined();
    expect(out.verified_from_reread).toEqual([{ id: 'est_1', status: 'Declined', approval_date: null }]);
    expect(out.awaiting_approval).toBe(false);
  });

  it('refuses ids that are not options on this estimate, before sending anything', async () => {
    const s = scripted(ESTIMATE, ESTIMATE);
    const h = await harnessWith(s.fetchImpl);

    const res = await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1', 'est_other'], confirm: true });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/est_other/);
    expect(s.posts()).toBe(0);
  });

  it('refuses options that are already declined or approved, before sending anything', async () => {
    const before = withOptions(
      { id: 'est_1' },
      { id: 'est_2', status: 'Declined' },
      // Approved options carry an approval date; the status may be absent.
      { id: 'est_3', status: undefined, approval_date: '2026-09-01T00:00:00Z' },
    );
    const s = scripted(before, before);
    const h = await harnessWith(s.fetchImpl);

    const res = await h.callTool('housecallpro_decline_estimate', {
      option_ids: ['est_1', 'est_2', 'est_3'],
      confirm: true,
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res);
    expect(text).toMatch(/est_2 \(Declined\)/);
    expect(text).toMatch(/est_3 \(approved\)/);
    expect(s.posts()).toBe(0);
  });

  it('reports an error, not success, when the re-read shows nothing was declined', async () => {
    // The upstream answered 2xx but ignored the body: the option is still open.
    const s = scripted(ESTIMATE, ESTIMATE);
    const h = await harnessWith(s.fetchImpl);

    const res = await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'], confirm: true });

    expect(s.posts()).toBe(1);
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res);
    expect(text).toMatch(/est_1/);
    expect(text).toMatch(/Awaiting Approval/);
    expect(text).not.toMatch(/"declined":\["est_1"\]/);
  });

  it('lists only the re-read-confirmed ids as declined when the write partly landed', async () => {
    const before = withOptions({ id: 'est_1' }, { id: 'est_2' }, { id: 'est_3' });
    // est_3 vanishes from the re-read entirely: that is not a confirmation either.
    const after = withOptions({ id: 'est_1', status: 'Declined' }, { id: 'est_2' });
    const s = scripted(before, after);
    const h = await harnessWith(s.fetchImpl);

    const out = parseToolResult(
      await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1', 'est_2', 'est_3'], confirm: true }),
    );

    expect(out.declined).toEqual(['est_1']);
    expect(out.not_confirmed).toEqual([
      { id: 'est_2', status: 'Awaiting Approval', approval_date: null },
      { id: 'est_3', status: 'missing from re-read', approval_date: null },
    ]);
    expect(out.warning).toMatch(/not report them as declined/i);
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
  it('reports unconfigured as healthy — a per-call link is the normal case', async () => {
    const h = await harnessWith(json(ESTIMATE) as unknown as typeof fetch, {});
    const out = parseToolResult(await h.callTool('housecallpro_healthcheck', {}));
    expect(out.status).toBe('ok_no_link_configured');
    expect(out.links_configured).toBe(0);
  });

  it('reports ok when a link resolves', async () => {
    const h = await harnessWith(json(ESTIMATE) as unknown as typeof fetch);
    const out = parseToolResult(await h.callTool('housecallpro_healthcheck', {}));
    expect(out.status).toBe('ok');
    expect(out.estimate_number).toBe('900000001');
  });
});

describe('housecallpro_list_links', () => {
  it('returns labels and kinds, and never a token', async () => {
    const h = await harnessWith(json(ESTIMATE) as unknown as typeof fetch, {
      HOUSECALLPRO_LINKS: JSON.stringify([
        { label: 'tankless', url: `https://client.housecallpro.com/estimates/${TOKEN}` },
        { label: 'hvac', url: TOKEN },
      ]),
    });

    const res = await h.callTool('housecallpro_list_links', {});
    const out = parseToolResult<{ links: { label: string; kind: string; isDefault: boolean }[] }>(
      res,
    );

    expect(out.links).toEqual([
      { label: 'tankless', kind: 'estimate', isDefault: true },
      { label: 'hvac', kind: 'unknown', isDefault: false },
    ]);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});
