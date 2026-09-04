/**
 * The `view` vocabulary: which rung each tool honours, what each one returns,
 * and the two things that must never happen — `view` on the wire, and a rung
 * this server cannot honour being advertised.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HousecallProClient } from '../src/client.js';
import { LinkRegistry } from '../src/links.js';
import { HCP_VIEWS, viewEstimate, viewInvoice } from '../src/normalize.js';
import { registerEstimateTools } from '../src/tools/estimates.js';

const ESTIMATE_TOKEN = `${'a'.repeat(64)}_${'b'.repeat(64)}`;
const INVOICE_TOKEN = 'e'.repeat(32);

const ESTIMATE_DOC = {
  object: 'customer_estimate',
  estimate: { object: 'estimate', data: { estimate_number: '1001', estimate_uuid: 'est_x' } },
  options: {
    object: 'list',
    data: [
      {
        id: 'est_opt_1',
        status: 'Awaiting Approval',
        approval_date: null,
        sub_total: 32000,
        total_amount: 34639,
        line_items: { object: 'list', data: [{ name: 'Flush', unit_price: 32000, amount: 32000 }] },
      },
    ],
  },
  company_name: 'Example Plumbing',
  payment_options: { can_pay_online: true },
};

const INVOICE_DOC = {
  object: 'consumer_invoice',
  amount: 37888,
  due_amount: 0,
  subtotal: 35000,
  total: 37888,
  invoice_number: '900000002',
  status: 'paid',
  company_info: { name: 'Example Plumbing', organization_uuid: 'org_1' },
  payment_options: { can_pay_online: false },
};

/** A harness plus the fetch spy behind it, so a test can inspect what went out. */
async function harness(doc: unknown, token = ESTIMATE_TOKEN) {
  const fetchImpl = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } }),
    ),
  );
  const client = new HousecallProClient(new LinkRegistry({ HOUSECALLPRO_LINK: token }), {
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const h = await createTestHarness((server) => registerEstimateTools(server, client));
  return { h, fetchImpl };
}

/** The single text block a fleet tool returns, unparsed. */
function textOf(result: CallToolResult): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

describe('the rung ladder', () => {
  it('honours exactly compact and raw — no `full`, which would alias compact', () => {
    expect(HCP_VIEWS).toEqual(['compact', 'raw']);
  });

  it('defaults to compact when no view is named', async () => {
    const { h } = await harness(ESTIMATE_DOC);
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_estimate', {}),
    );
    expect(out['estimate_number']).toBe('1001');
    expect(out['options']).toHaveLength(1);
    // The projection's whole point: money arrives twice, never as bare cents.
    expect((out['options'] as Record<string, unknown>[])[0]?.['total_amount_usd']).toBe(346.39);
  });

  it('defaults to compact on the invoice too', async () => {
    const { h } = await harness(INVOICE_DOC, INVOICE_TOKEN);
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_invoice', {}),
    );
    expect(out['total_usd']).toBe(378.88);
    expect(out['is_paid']).toBe(true);
  });

  it('returns the upstream document, wrappers and all, on raw', async () => {
    const { h } = await harness(ESTIMATE_DOC);
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_estimate', { view: 'raw' }),
    );
    expect(out['object']).toBe('customer_estimate');
    expect(out['options']).toHaveProperty('data');
    // Raw is the upstream document: money is integer cents, with no `*_usd`.
    expect(JSON.stringify(out)).not.toMatch(/_usd/);
  });

  it('refuses a rung this server does not honour', async () => {
    const { h } = await harness(ESTIMATE_DOC);
    const failure = await h
      .callTool('housecallpro_get_estimate', { view: 'full' })
      .then((r) => JSON.stringify(r))
      .catch((e: unknown) => String(e));
    expect(failure).toMatch(/at view/i);
    // The refusal names the rungs that DO exist, so a caller is not left
    // guessing which value it should have sent.
    expect(failure).toMatch(/expected one of .*compact.*raw/);
  });

  it('advertises the rungs, and their money difference, in the parameter description', async () => {
    const { h } = await harness(ESTIMATE_DOC);
    const tools = await h.client.listTools();
    const estimate = tools.tools.find((t) => t.name === 'housecallpro_get_estimate');
    const view = (estimate?.inputSchema.properties as Record<string, { description?: string }>)?.[
      'view'
    ];
    // `.describe()` after `.optional()`, or this lands on the inner type and
    // the host reads a blank description.
    expect(view?.description).toMatch(/"compact" \(default\)/);
    expect(view?.description).toMatch(/CENTS/);
    expect(view?.description).not.toMatch(/"full"/);
  });
});

describe('what must never happen', () => {
  it('never puts `view` on the wire', async () => {
    const { h, fetchImpl } = await harness(ESTIMATE_DOC);
    await h.callTool('housecallpro_get_estimate', { view: 'compact' });
    await h.callTool('housecallpro_get_estimate', { view: 'raw' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls as [string, RequestInit | undefined][]) {
      expect(String(url)).not.toMatch(/view/i);
      expect(init?.body ?? '').toBe('');
    }
  });

  it('no longer treats the old boolean `raw` as a rung selector', async () => {
    const { h } = await harness(ESTIMATE_DOC);
    // `view` replaced it outright. An unknown key is dropped by the schema, so
    // a stale caller gets the CHEAP answer rather than an error — the safe
    // direction to fail in, and the reason the alias was not kept.
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_estimate', { raw: true }),
    );
    expect(out['estimate_number']).toBe('1001');
    expect(out['object']).toBeUndefined();
  });

  it('minifies compact and indents raw', async () => {
    const { h } = await harness(ESTIMATE_DOC);
    expect(textOf(await h.callTool('housecallpro_get_estimate', {}))).not.toMatch(/\n/);
    expect(textOf(await h.callTool('housecallpro_get_estimate', { view: 'raw' }))).toMatch(/\n/);
  });
});

describe('a projection that loses its footing', () => {
  it('hands back the whole document instead of an empty summary', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // `null` is not an estimate envelope: the projector throws on it. The guard
    // must return what we received — an empty summary would read as an estimate
    // with nothing on it.
    const out = viewEstimate('compact', null as never);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not project/));
    warn.mockRestore();
  });

  it('does the same for an invoice', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = viewInvoice('compact', null as never);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not project/));
    warn.mockRestore();
  });
});
