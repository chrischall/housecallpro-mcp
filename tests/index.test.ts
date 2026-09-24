import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult, type TestHarnessOptions } from '@chrischall/mcp-utils/test';
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

function harnessWith(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv = { HOUSECALLPRO_LINK: TOKEN },
  options?: TestHarnessOptions,
) {
  const client = new HousecallProClient(new LinkRegistry(env), { fetchImpl });
  return createTestHarness((server) => {
    registerEstimateTools(server, client);
    registerHealthcheckTools(server, client);
  }, options);
}

// Tool results are loosely shaped JSON; the assertions are the type check.
const parse = (res: unknown) => parseToolResult<Record<string, any>>(res as Parameters<typeof parseToolResult>[0]);

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
  // A harness created without an elicitation handler is a client that cannot
  // be prompted, so the default MCP_CONFIRM_MODE (ask-user) takes the two-step
  // token flow: phase 1 previews, phase 2 with the token acts.
  const savedMode = process.env.MCP_CONFIRM_MODE;
  afterEach(() => {
    if (savedMode === undefined) delete process.env.MCP_CONFIRM_MODE;
    else process.env.MCP_CONFIRM_MODE = savedMode;
  });

  /**
   * A fetch that serves the estimate for GETs and `{ ok: true }` for the
   * decline POST, recording every call. `afterPost` is the estimate the
   * re-read sees once the POST has been made.
   */
  function scripted(before: unknown, afterPost: unknown) {
    const calls: Array<{ method: string; url: string }> = [];
    let posted = false;
    let current = before;
    const fetchImpl = ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(url) });
      if (method === 'POST') {
        posted = true;
        return json({ ok: true })();
      }
      return json(posted ? afterPost : current)();
    }) as unknown as typeof fetch;
    return {
      fetchImpl,
      calls,
      posts: () => calls.filter((c) => c.method === 'POST').length,
      /** Change what every GET returns from now on — the estimate moved under us. */
      setBefore: (next: unknown) => { current = next; posted = false; },
    };
  }

  function withOptions(...options: Array<Record<string, unknown>>) {
    const e = structuredClone(ESTIMATE);
    e.options.data = options.map((o) => ({ object: 'option', status: 'Awaiting Approval', approval_date: null, ...o })) as typeof e.options.data;
    return e;
  }

  /** Phase 1 then phase 2 with the returned token. */
  async function confirmed(h: Awaited<ReturnType<typeof harnessWith>>, args: Record<string, unknown>) {
    const preview = parse(await h.callTool('housecallpro_decline_estimate', args));
    expect(preview.status).toBe('confirmation-required');
    return h.callTool('housecallpro_decline_estimate', { ...args, confirmToken: preview.confirmToken });
  }

  it('phase 1 previews exactly what would be sent and posts nothing', async () => {
    const s = scripted(ESTIMATE, ESTIMATE);
    const h = await harnessWith(s.fetchImpl);

    const out = parse(await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] }));

    expect(out.status).toBe('confirmation-required');
    expect(out.dispatched).toBe(false);
    expect(typeof out.confirmToken).toBe('string');
    expect(out.preview.would_send).toEqual({
      method: 'POST',
      path: '/api/estimates/estimate_options/customer_declines',
      estimate_option_uuids: ['est_1'],
    });
    expect(out.preview.effect).toMatch(/declined/);
    expect(out.preview.estimate_number).toBe('900000001');
    expect(out.preview.options).toEqual([
      { id: 'est_1', status: 'Awaiting Approval', approval_date: null, total_amount_usd: 346.39 },
    ]);
    expect(s.posts()).toBe(0);
    // The retrieval token is a credential: never in the preview or the confirm token.
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(Buffer.from(String(out.confirmToken).split('.').slice(-2, -1)[0] ?? '', 'base64url').toString()).not.toContain(TOKEN);
  });

  it('declines with the token and reports the state read back afterwards', async () => {
    const declined = withOptions({ id: 'est_1', status: 'Declined' });
    const s = scripted(ESTIMATE, declined);

    const h = await harnessWith(s.fetchImpl);
    const out = parse(await confirmed(h, { option_ids: ['est_1'] }));

    expect(s.posts()).toBe(1);
    expect(out.declined).toEqual(['est_1']);
    expect(out.not_confirmed).toBeUndefined();
    expect(out.verified_from_reread).toEqual([{ id: 'est_1', status: 'Declined', approval_date: null }]);
    expect(out.awaiting_approval).toBe(false);
  });

  it('refuses a replayed token and posts nothing more', async () => {
    const s = scripted(ESTIMATE, withOptions({ id: 'est_1', status: 'Declined' }));
    const h = await harnessWith(s.fetchImpl);

    const preview = parse(await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] }));
    const args = { option_ids: ['est_1'], confirmToken: preview.confirmToken };
    await h.callTool('housecallpro_decline_estimate', args);
    expect(s.posts()).toBe(1);

    // Undo the decline so the replay would pass the already-decided guard and
    // reach the token check.
    s.setBefore(ESTIMATE);
    const replay = await h.callTool('housecallpro_decline_estimate', args);
    expect(replay.isError).toBe(true);
    expect(parse(replay).error).toBe('TOKEN_REUSED');
    expect(s.posts()).toBe(1);
  });

  it('refuses a token whose arguments changed between the phases (DRAFT_CHANGED)', async () => {
    const before = withOptions({ id: 'est_1' }, { id: 'est_2' });
    const s = scripted(before, before);
    const h = await harnessWith(s.fetchImpl);

    const preview = parse(await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] }));
    const res = await h.callTool('housecallpro_decline_estimate', {
      option_ids: ['est_1', 'est_2'],
      confirmToken: preview.confirmToken,
    });

    expect(res.isError).toBe(true);
    const out = parse(res);
    expect(out.error).toBe('DRAFT_CHANGED');
    expect(out.preview.would_send.estimate_option_uuids).toEqual(['est_1', 'est_2']);
    expect(s.posts()).toBe(0);
  });

  it('refuses a token when the estimate itself changed between the phases', async () => {
    const before = withOptions({ id: 'est_1', total_amount: 34639 });
    const s = scripted(before, before);
    const h = await harnessWith(s.fetchImpl);

    const preview = parse(await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] }));
    // The contractor re-quoted the option before the user approved.
    s.setBefore(withOptions({ id: 'est_1', total_amount: 29900 }));
    const res = await h.callTool('housecallpro_decline_estimate', {
      option_ids: ['est_1'],
      confirmToken: preview.confirmToken,
    });

    expect(parse(res).error).toBe('DRAFT_CHANGED');
    expect(s.posts()).toBe(0);
  });

  it('declines when a client that can prompt accepts', async () => {
    const s = scripted(ESTIMATE, withOptions({ id: 'est_1', status: 'Declined' }));
    const h = await harnessWith(s.fetchImpl, undefined, {
      elicitation: async () => ({ action: 'accept', content: { confirmed: true } }),
    });

    const out = parse(await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] }));

    expect(out.declined).toEqual(['est_1']);
    expect(s.posts()).toBe(1);
  });

  it('does not decline when a client that can prompt declines', async () => {
    const s = scripted(ESTIMATE, ESTIMATE);
    const h = await harnessWith(s.fetchImpl, undefined, {
      elicitation: async () => ({ action: 'decline' }),
    });

    await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] });

    expect(s.posts()).toBe(0);
  });

  it('refuses outright under MCP_CONFIRM_MODE=refuse on a client that cannot prompt', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const s = scripted(ESTIMATE, ESTIMATE);
    const h = await harnessWith(s.fetchImpl);

    const res = await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] });

    expect(JSON.stringify(res)).toContain('confirmation-unsupported');
    expect(s.posts()).toBe(0);
  });

  it('refuses ids that are not options on this estimate, before sending anything', async () => {
    const s = scripted(ESTIMATE, ESTIMATE);
    const h = await harnessWith(s.fetchImpl);

    const res = await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1', 'est_other'] });

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
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res);
    expect(text).toMatch(/est_2 \(Declined\)/);
    expect(text).toMatch(/est_3 \(approved\)/);
    expect(s.posts()).toBe(0);
  });

  it('still refuses with a valid token when the option was decided between the phases', async () => {
    const s = scripted(ESTIMATE, ESTIMATE);
    const h = await harnessWith(s.fetchImpl);

    const preview = parse(await h.callTool('housecallpro_decline_estimate', { option_ids: ['est_1'] }));
    s.setBefore(withOptions({ id: 'est_1', status: 'Declined' }));
    const res = await h.callTool('housecallpro_decline_estimate', {
      option_ids: ['est_1'],
      confirmToken: preview.confirmToken,
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/est_1 \(Declined\)/);
    expect(s.posts()).toBe(0);
  });

  it('reports an error, not success, when the re-read shows nothing was declined', async () => {
    // The upstream answered 2xx but ignored the body: the option is still open.
    const s = scripted(ESTIMATE, ESTIMATE);
    const h = await harnessWith(s.fetchImpl);

    const res = await confirmed(h, { option_ids: ['est_1'] });

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

    const out = parse(await confirmed(h, { option_ids: ['est_1', 'est_2', 'est_3'] }));

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
    const out = parse(await h.callTool('housecallpro_healthcheck', {}));
    expect(out.status).toBe('ok_no_link_configured');
    expect(out.links_configured).toBe(0);
  });

  it('reports ok when a link resolves', async () => {
    const h = await harnessWith(json(ESTIMATE) as unknown as typeof fetch);
    const out = parse(await h.callTool('housecallpro_healthcheck', {}));
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
