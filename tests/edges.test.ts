/** Failure paths and degenerate inputs — the branches the happy path never reaches. */
import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { HousecallProClient } from '../src/client.js';
import { LinkRegistry, parseLink } from '../src/links.js';
import { summarizeEstimate } from '../src/normalize.js';
import { registerEstimateTools } from '../src/tools/estimates.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import type { EstimateResponse } from '../src/client.js';
import * as lib from '../src/lib.js';

const TOKEN = `${'a'.repeat(64)}_${'b'.repeat(64)}`;

function clientFor(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { HOUSECALLPRO_LINK: TOKEN }) {
  return new HousecallProClient(new LinkRegistry(env), { fetchImpl });
}

describe('lib barrel', () => {
  it('re-exports the public surface', () => {
    expect(lib.HousecallProClient).toBe(HousecallProClient);
    expect(lib.LinkRegistry).toBe(LinkRegistry);
    expect(typeof lib.summarizeEstimate).toBe('function');
    expect(typeof lib.parseLink).toBe('function');
    expect(lib.RETRIEVAL_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(lib.API_ORIGIN).toBe('https://app.housecallpro.com');
    expect(lib.CLIENT_ORIGIN).toBe('https://client.housecallpro.com');
    expect(lib.SHORT_ORIGIN).toBe('https://pro.housecallpro.com');
    expect(typeof lib.VERSION).toBe('string');
  });
});

describe('client transport failures', () => {
  it('wraps a transport throw on a read', async () => {
    const client = clientFor(
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch,
    );
    await expect(client.getEstimate()).rejects.toThrow(/Could not reach housecallpro\.com/);
  });

  it('wraps a transport throw while resolving a short link', async () => {
    const client = clientFor(
      vi.fn().mockRejectedValue(new Error('DNS')) as unknown as typeof fetch,
      { HOUSECALLPRO_LINK: 'https://pro.housecallpro.com/mobile_estimate/abc123' },
    );
    await expect(client.getEstimate()).rejects.toThrow(/Could not reach housecallpro\.com/);
  });

  it('reports an unexpected upstream status plainly', async () => {
    const client = clientFor(
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(client.getEstimate()).rejects.toThrow(/HTTP 500/);
  });
});

describe('parseLink edges', () => {
  it('rejects an empty string', () => {
    expect(() => parseLink('   ')).toThrow(/Empty link/);
  });

  it('treats a short-route URL with no code as a short link', () => {
    expect(parseLink('https://pro.housecallpro.com/mobile_estimate')).toEqual({
      kind: 'estimate',
      shortUrl: 'https://pro.housecallpro.com/mobile_estimate',
    });
  });

  it('recognises the invoice short route', () => {
    expect(parseLink('https://pro.housecallpro.com/mobile_invoice/xyz').kind).toBe('invoice');
  });

  it('rejects a housecallpro.com URL that carries neither token nor known route', () => {
    expect(() => parseLink('https://www.housecallpro.com/pricing')).toThrow(/Not a Housecall Pro/);
  });

  it('classifies a bare token as unknown kind', () => {
    expect(parseLink(`  ${TOKEN}  `)).toEqual({ kind: 'unknown', token: TOKEN });
  });
});

describe('LinkRegistry edges', () => {
  it('rejects HOUSECALLPRO_LINKS that is valid JSON but not an array', () => {
    const reg = new LinkRegistry({ HOUSECALLPRO_LINKS: '"nope"' });
    expect(() => reg.resolve()).toThrow(/must be a JSON array/);
  });
});

describe('summarizeEstimate degenerate shapes', () => {
  it('treats a non-array options.data as no options', () => {
    const raw = { estimate: { data: {} }, options: { data: 'nope' } } as unknown as EstimateResponse;
    expect(summarizeEstimate(raw).options).toEqual([]);
  });

  it('ignores a payment_options that is not an object', () => {
    const raw = {
      estimate: { data: {} },
      options: { data: [] },
      payment_options: 'nope',
    } as unknown as EstimateResponse;
    expect(summarizeEstimate(raw).can_pay_online).toBeUndefined();
  });

  it('ignores an options wrapper that is not an object at all', () => {
    const raw = { estimate: 'nope', options: null } as unknown as EstimateResponse;
    const s = summarizeEstimate(raw);
    expect(s.options).toEqual([]);
    expect(s.estimate_number).toBeUndefined();
  });

  it('drops non-object entries inside options.data', () => {
    const raw = {
      estimate: { data: {} },
      options: { data: [null, 'x', { id: 'est_1' }] },
    } as unknown as EstimateResponse;
    expect(summarizeEstimate(raw).options).toHaveLength(1);
  });
});

describe('tool error paths', () => {
  async function harness(fetchImpl: typeof fetch, env?: NodeJS.ProcessEnv) {
    const client = clientFor(fetchImpl, env);
    return createTestHarness((server) => {
      registerEstimateTools(server, client);
      registerHealthcheckTools(server, client);
    });
  }

  const okEstimate = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          estimate: { data: { estimate_number: '1' } },
          options: { data: [{ id: 'est_1', status: 'Awaiting Approval', approval_date: null }] },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );

  it('returns the raw document when asked', async () => {
    const h = await harness(okEstimate as unknown as typeof fetch);
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_estimate', { view: 'raw' }),
    );
    // The raw envelope keeps its wrappers; the summary would have flattened them.
    expect(out['options']).toHaveProperty('data');
  });

  it('healthcheck reports the error instead of throwing', async () => {
    const h = await harness(
      vi.fn().mockResolvedValue(new Response('nope', { status: 500 })) as unknown as typeof fetch,
    );
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_healthcheck', {}),
    );
    expect(out['status']).toBe('error');
    expect(String(out['error'])).toMatch(/HTTP 500/);
  });

  it('get_company rejects a non-uuid through the tool layer', async () => {
    const h = await harness(okEstimate as unknown as typeof fetch);
    const res = await h.callTool('housecallpro_get_company', { organization_id: 'nope' });
    expect(JSON.stringify(res)).toMatch(/UUID/i);
  });
});

describe('remaining branches', () => {
  it('falls back to the global fetch when none is injected', () => {
    const client = new HousecallProClient(new LinkRegistry({ HOUSECALLPRO_LINK: TOKEN }));
    expect(client.links.configured).toBe(true);
  });

  it('fails a short link whose redirect has no Location header at all', async () => {
    const client = clientFor(
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof fetch,
      { HOUSECALLPRO_LINK: 'https://pro.housecallpro.com/mobile_estimate/abc123' },
    );
    await expect(client.getEstimate()).rejects.toThrow(/Could not resolve that short link/);
  });

  it('rejects a string that looks like a URL but will not parse', () => {
    expect(() => parseLink('https://[not a host]/x')).toThrow(/Not a valid URL/);
  });

  it('treats a wrapper whose data is not an object as absent', () => {
    const raw = {
      estimate: { data: { address: { data: 'nope' } } },
      options: { data: [] },
    } as unknown as EstimateResponse;
    expect(summarizeEstimate(raw).service_address).toBeUndefined();
  });

  it('approve refuses even with no option_ids given', async () => {
    const client = clientFor(vi.fn() as unknown as typeof fetch);
    const h = await createTestHarness((server) => registerEstimateTools(server, client));
    const res = await h.callTool('housecallpro_approve_estimate', {});
    expect(JSON.stringify(res)).toMatch(/reCAPTCHA/i);
  });

  it('summarises when compact is named explicitly', async () => {
    const client = clientFor(
      (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ estimate: { data: { estimate_number: '9' } }, options: { data: [] } }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )) as unknown as typeof fetch,
    );
    const h = await createTestHarness((server) => registerEstimateTools(server, client));
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_estimate', { view: 'compact' }),
    );
    expect(out['estimate_number']).toBe('9');
  });
});

describe('final branches', () => {
  it('rejects a housecallpro.com URL with no path at all', () => {
    expect(() => parseLink('https://client.housecallpro.com/')).toThrow(/Not a Housecall Pro/);
  });

  it('rejects a null entry inside HOUSECALLPRO_LINKS', () => {
    const reg = new LinkRegistry({ HOUSECALLPRO_LINKS: '[null]' });
    expect(() => reg.resolve()).toThrow(/"label" and a "url"/);
  });

  it('approve refuses when option_ids is explicitly provided', async () => {
    const client = clientFor(vi.fn() as unknown as typeof fetch);
    const h = await createTestHarness((server) => registerEstimateTools(server, client));
    const res = await h.callTool('housecallpro_approve_estimate', {
      option_ids: ['est_1'],
      link: 'default',
    });
    expect(JSON.stringify(res)).toMatch(/reCAPTCHA/i);
  });
});

describe('unknown route with a valid token', () => {
  it('accepts the token but leaves the kind unknown', () => {
    expect(parseLink(`https://client.housecallpro.com/something_new/${TOKEN}`)).toEqual({
      kind: 'unknown',
      token: TOKEN,
    });
  });
});
