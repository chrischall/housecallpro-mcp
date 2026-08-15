/**
 * A Housecall Pro link is per-document and disposable — there is no standing
 * link to configure. So every tool must accept a link directly, and the server
 * must be fully usable with nothing configured at all (which is how it runs as
 * a hosted connector, where there is no .env to hold a secret).
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { HousecallProClient } from '../src/client.js';
import { LinkRegistry } from '../src/links.js';
import { registerEstimateTools } from '../src/tools/estimates.js';

const ESTIMATE_TOKEN = `${'a'.repeat(64)}_${'b'.repeat(64)}`;
const INVOICE_TOKEN = 'e'.repeat(32);
const SHORT = 'https://pro.housecallpro.com/mobile_estimate/Ex4mpl3Cod';

const ESTIMATE_BODY = {
  estimate: { data: { estimate_number: '900000001' } },
  options: { data: [{ id: 'est_1', status: 'Awaiting Approval', approval_date: null }] },
};
const INVOICE_BODY = { object: 'consumer_invoice', invoice_number: '900000002', due_amount: 0 };

function jsonFetch(body: unknown) {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    ),
  );
}

/** The hosted shape: no environment at all. */
function unconfigured(fetchImpl: ReturnType<typeof vi.fn>) {
  return new HousecallProClient(new LinkRegistry({}), { fetchImpl: fetchImpl as unknown as typeof fetch });
}

describe('a link passed per call, with nothing configured', () => {
  it('reads an estimate from a bare token', async () => {
    const fetchImpl = jsonFetch(ESTIMATE_BODY);
    const out = await unconfigured(fetchImpl).getEstimate(ESTIMATE_TOKEN);

    expect(out.estimate.data['estimate_number']).toBe('900000001');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://app.housecallpro.com/alpha/customer_estimates/${ESTIMATE_TOKEN}`,
    );
  });

  it('reads an estimate from a full portal URL', async () => {
    const fetchImpl = jsonFetch(ESTIMATE_BODY);
    await unconfigured(fetchImpl).getEstimate(
      `https://client.housecallpro.com/estimates/${ESTIMATE_TOKEN}`,
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toContain(ESTIMATE_TOKEN);
  });

  it('reads an invoice from a link', async () => {
    const fetchImpl = jsonFetch(INVOICE_BODY);
    const out = await unconfigured(fetchImpl).getInvoice(
      `https://client.housecallpro.com/invoices/${INVOICE_TOKEN}`,
    );
    expect(out['invoice_number']).toBe('900000002');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('/api/invoices/consumer/v1/invoices/');
  });

  it('follows a short link given per call', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: `https://client.housecallpro.com/estimates/${ESTIMATE_TOKEN}` },
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(ESTIMATE_BODY), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

    const client = unconfigured(fetchImpl);
    await client.getEstimate(SHORT);
    await client.getEstimate(SHORT);

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    // 1 redirect probe + 2 reads: the short link resolves once per client,
    // keyed by the URL rather than by a configured label.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('still refuses a wrong-shape link passed per call', async () => {
    const fetchImpl = vi.fn();
    await expect(unconfigured(fetchImpl).getInvoice(ESTIMATE_TOKEN)).rejects.toThrow(
      /estimate link/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a foreign host passed per call', async () => {
    const fetchImpl = vi.fn();
    await expect(
      unconfigured(fetchImpl).getEstimate('https://evil.example.com/estimates/x'),
    ).rejects.toThrow(/housecallpro\.com/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still tells the user what to do when neither a link nor config exists', async () => {
    await expect(unconfigured(vi.fn()).getEstimate()).rejects.toThrow(/link/i);
  });
});

describe('configured labels still work', () => {
  it('resolves a label when one is configured', async () => {
    const fetchImpl = jsonFetch(ESTIMATE_BODY);
    const client = new HousecallProClient(
      new LinkRegistry({
        HOUSECALLPRO_LINKS: JSON.stringify([{ label: 'tankless', url: ESTIMATE_TOKEN }]),
      }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    await client.getEstimate('tankless');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain(ESTIMATE_TOKEN);
  });

  it('prefers a real link over a same-named label', async () => {
    const other = `${'c'.repeat(64)}_${'d'.repeat(64)}`;
    const fetchImpl = jsonFetch(ESTIMATE_BODY);
    const client = new HousecallProClient(
      new LinkRegistry({
        HOUSECALLPRO_LINKS: JSON.stringify([{ label: 'tankless', url: other }]),
      }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    await client.getEstimate(ESTIMATE_TOKEN);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain(ESTIMATE_TOKEN);
  });
});

describe('through the tool layer, unconfigured', () => {
  async function harness(body: unknown) {
    const client = unconfigured(jsonFetch(body));
    return createTestHarness((server) => registerEstimateTools(server, client));
  }

  it('housecallpro_get_estimate accepts a link argument', async () => {
    const h = await harness(ESTIMATE_BODY);
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_estimate', { link: ESTIMATE_TOKEN }),
    );
    expect(out['estimate_number']).toBe('900000001');
  });

  it('housecallpro_get_invoice accepts a link argument', async () => {
    const h = await harness(INVOICE_BODY);
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_invoice', { link: INVOICE_TOKEN }),
    );
    expect(out['invoice_number']).toBe('900000002');
  });

  it('never echoes the link back in a result', async () => {
    const h = await harness(ESTIMATE_BODY);
    const res = await h.callTool('housecallpro_get_estimate', { link: ESTIMATE_TOKEN });
    expect(JSON.stringify(res)).not.toContain(ESTIMATE_TOKEN);
  });
});
