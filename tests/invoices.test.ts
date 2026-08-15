import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { HousecallProClient, type InvoiceResponse } from '../src/client.js';
import { LinkRegistry, parseLink, tokenShape } from '../src/links.js';
import { summarizeInvoice } from '../src/normalize.js';
import { registerEstimateTools } from '../src/tools/estimates.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

const ESTIMATE_TOKEN = `${'a'.repeat(64)}_${'b'.repeat(64)}`;
const INVOICE_TOKEN = 'e'.repeat(32);

/**
 * Built from a real captured response, with identifying values replaced. Flat —
 * the invoice document has none of the estimate's `{object, data}` wrappers.
 */
function fixture(): InvoiceResponse {
  return {
    object: 'consumer_invoice',
    amount: 37888,
    due_amount: 0,
    subtotal: 35000,
    total: 37888,
    invoice_number: '900000002',
    invoice_count: 1,
    status: 'paid',
    template: 'dynamic',
    company_info: {
      name: 'Example Plumbing',
      logo_url: 'https://example.com/logo.png',
      organization_uuid: '6e14b390-4b34-4338-a7c2-89d248ca25c8',
      can_accept_gratuity: true,
      country: 'US',
      analytics_uuid: 'anl_1',
      phone_number: '(704) 555-1234',
      email: 'info@example.com',
      website: 'https://example.com',
    },
    customer: { email: null, card_on_file: null, uuid: 'cus_1', mobile_number: '7045550000' },
    financing_options: [],
    videos: [],
    payment_options: {
      cc_enabled: true,
      ach_enabled: true,
      can_save_card_on_file: true,
      can_pay_online: true,
      klarna_enabled: false,
      paypal_enabled: false,
      paypal_pay_later_enabled: false,
      paypal_venmo_enabled: false,
    },
    cross_selling_products: null,
  };
}

describe('invoice token shape', () => {
  it('recognises a 32-hex invoice token, which is NOT the estimate shape', () => {
    expect(tokenShape(INVOICE_TOKEN)).toBe('invoice');
    expect(tokenShape(ESTIMATE_TOKEN)).toBe('estimate');
    expect(tokenShape('nope')).toBeUndefined();
  });

  it('parses an invoice portal URL', () => {
    expect(parseLink(`https://client.housecallpro.com/invoices/${INVOICE_TOKEN}`)).toEqual({
      kind: 'invoice',
      token: INVOICE_TOKEN,
    });
  });

  it('accepts a bare invoice token, which the old estimate-only regex rejected', () => {
    expect(parseLink(INVOICE_TOKEN)).toEqual({ kind: 'unknown', token: INVOICE_TOKEN });
  });

  it('parses the mobile_invoice short link', () => {
    expect(parseLink('https://pro.housecallpro.com/mobile_invoice/Ex4mpl3Cod')).toEqual({
      kind: 'invoice',
      shortUrl: 'https://pro.housecallpro.com/mobile_invoice/Ex4mpl3Cod',
    });
  });

  it('registers an invoice link with the right kind', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINK: `https://client.housecallpro.com/invoices/${INVOICE_TOKEN}`,
    });
    expect(reg.list()).toEqual([{ label: 'default', kind: 'invoice', isDefault: true }]);
  });
});

describe('summarizeInvoice', () => {
  it('reports money in both cents and dollars', () => {
    const s = summarizeInvoice(fixture());

    expect(s.total_cents).toBe(37888);
    expect(s.total_usd).toBe(378.88);
    expect(s.subtotal_cents).toBe(35000);
    expect(s.subtotal_usd).toBe(350);
    expect(s.due_cents).toBe(0);
    expect(s.due_usd).toBe(0);
  });

  it('derives the tax the response never states outright', () => {
    // The invoice document has no tax field; total - subtotal is the only
    // way to surface it, and it is what the portal shows.
    expect(summarizeInvoice(fixture()).tax_usd).toBe(28.88);
  });

  it('reports paid state from due_amount, not just the status string', () => {
    const s = summarizeInvoice(fixture());
    expect(s.status).toBe('paid');
    expect(s.is_paid).toBe(true);
  });

  it('treats an outstanding balance as unpaid', () => {
    const raw = fixture();
    raw['due_amount'] = 37888;
    raw['status'] = 'sent';
    const s = summarizeInvoice(raw);
    expect(s.is_paid).toBe(false);
    expect(s.due_usd).toBe(378.88);
  });

  it('lifts the company block', () => {
    expect(summarizeInvoice(fixture()).company).toEqual({
      name: 'Example Plumbing',
      phone: '(704) 555-1234',
      email: 'info@example.com',
      website: 'https://example.com',
      organization_id: '6e14b390-4b34-4338-a7c2-89d248ca25c8',
    });
  });

  it('reports whether it can still be paid online', () => {
    expect(summarizeInvoice(fixture()).can_pay_online).toBe(true);
  });

  it('degrades rather than throwing on a stripped document', () => {
    const s = summarizeInvoice({});
    expect(s.total_cents).toBeUndefined();
    expect(s.tax_usd).toBeUndefined();
    expect(s.is_paid).toBe(false);
    expect(s.company).toEqual({});
  });
});

describe('client.getInvoice', () => {
  function clientFor(fetchImpl: typeof fetch, link = INVOICE_TOKEN) {
    return new HousecallProClient(new LinkRegistry({ HOUSECALLPRO_LINK: link }), { fetchImpl });
  }

  it('calls the v1 path — the non-v1 one 404s upstream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixture()), { headers: { 'content-type': 'application/json' } }),
    );
    const client = clientFor(fetchImpl as unknown as typeof fetch);

    await client.getInvoice();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://app.housecallpro.com/api/invoices/consumer/v1/invoices/${INVOICE_TOKEN}`,
    );
  });

  it('refuses an estimate token before spending a request', async () => {
    const fetchImpl = vi.fn();
    const client = clientFor(fetchImpl as unknown as typeof fetch, ESTIMATE_TOKEN);
    await expect(client.getInvoice()).rejects.toThrow(/estimate link.*housecallpro_get_estimate/is);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an invoice token passed to getEstimate', async () => {
    const fetchImpl = vi.fn();
    const client = clientFor(fetchImpl as unknown as typeof fetch);
    await expect(client.getEstimate()).rejects.toThrow(/invoice link.*housecallpro_get_invoice/is);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names the selector in the wrong-shape error when one was given', async () => {
    const client = new HousecallProClient(
      new LinkRegistry({
        HOUSECALLPRO_LINKS: JSON.stringify([{ label: 'hvac', url: ESTIMATE_TOKEN }]),
      }),
      { fetchImpl: vi.fn() as unknown as typeof fetch },
    );
    await expect(client.getInvoice('hvac')).rejects.toThrow(/Link "hvac"/);
  });
});

describe('housecallpro_get_invoice', () => {
  async function harness(body: unknown) {
    const client = new HousecallProClient(
      new LinkRegistry({ HOUSECALLPRO_LINK: INVOICE_TOKEN }),
      {
        fetchImpl: (() =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              headers: { 'content-type': 'application/json' },
            }),
          )) as unknown as typeof fetch,
      },
    );
    return createTestHarness((server) => registerEstimateTools(server, client));
  }

  it('summarises by default', async () => {
    const h = await harness(fixture());
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_invoice', {}),
    );
    expect(out['total_usd']).toBe(378.88);
    expect(out['is_paid']).toBe(true);
  });

  it('returns the raw document when asked', async () => {
    const h = await harness(fixture());
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_get_invoice', { raw: true }),
    );
    expect(out['object']).toBe('consumer_invoice');
    expect(out['amount']).toBe(37888);
  });
});

// --- Regressions found by auto-review on PR #7 ---

describe('healthcheck with an invoice-only configuration', () => {
  it('reports ok, not error, and actually reaches the network', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(fixture()), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const client = new HousecallProClient(new LinkRegistry({ HOUSECALLPRO_LINK: INVOICE_TOKEN }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const h = await createTestHarness((server) => registerHealthcheckTools(server, client));

    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_healthcheck', {}),
    );

    expect(out['status']).toBe('ok');
    expect(out['invoice_number']).toBe('900000002');
    // The point of a healthcheck is reachability: it must actually call out.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still reports ok for an estimate link', async () => {
    const estimateBody = {
      estimate: { data: { estimate_number: '900000001' } },
      options: { data: [] },
    };
    const client = new HousecallProClient(new LinkRegistry({ HOUSECALLPRO_LINK: ESTIMATE_TOKEN }), {
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify(estimateBody), {
            headers: { 'content-type': 'application/json' },
          }),
        )) as unknown as typeof fetch,
    });
    const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_healthcheck', {}),
    );
    expect(out['status']).toBe('ok');
    expect(out['estimate_number']).toBe('900000001');
  });

  it('distinguishes a malformed link from no link at all', async () => {
    const client = new HousecallProClient(new LinkRegistry({ HOUSECALLPRO_LINK: 'x'.repeat(10) }), {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_healthcheck', {}),
    );
    // Reporting this as "no link configured" would hide the parse error.
    expect(out['status']).toBe('bad_link');
    expect(String(out['error'])).toMatch(/Not a Housecall Pro customer link/);
  });

  it('reports unconfigured as healthy, not an error', async () => {
    const client = new HousecallProClient(new LinkRegistry({}), {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
    const out = parseToolResult<Record<string, unknown>>(
      await h.callTool('housecallpro_healthcheck', {}),
    );
    expect(out['status']).toBe('ok_no_link_configured');
    expect(out['error']).toBeUndefined();
  });
});

describe('declineOptions guards the token shape', () => {
  it('refuses an invoice token instead of sending it to the estimate endpoint', async () => {
    const fetchImpl = vi.fn();
    const client = new HousecallProClient(new LinkRegistry({ HOUSECALLPRO_LINK: INVOICE_TOKEN }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.declineOptions(['est_1'])).rejects.toThrow(
      /invoice link.*housecallpro_get_invoice/is,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('parseLink rejection message', () => {
  it('describes both accepted token shapes, not just the estimate one', () => {
    let message = '';
    try {
      parseLink('not-a-link');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/129/);
    expect(message).toMatch(/32/);
    expect(message).toMatch(/mobile_invoice|invoices/);
  });
});

describe('not-found wording', () => {
  it('does not call an invoice an estimate', async () => {
    const client = new HousecallProClient(new LinkRegistry({ HOUSECALLPRO_LINK: INVOICE_TOKEN }), {
      fetchImpl: (() =>
        Promise.resolve(new Response('<html>404</html>', { status: 404 }))) as unknown as typeof fetch,
    });
    await expect(client.getInvoice()).rejects.toThrow(/404/);
    await expect(client.getInvoice()).rejects.not.toThrow(/an estimate/);
  });
});

describe('config problem classification', () => {
  it('exposes unset vs invalid on the registry itself', () => {
    expect(new LinkRegistry({}).problem).toBe('unset');
    expect(new LinkRegistry({ HOUSECALLPRO_LINK: 'nope' }).problem).toBe('invalid');
    expect(new LinkRegistry({ HOUSECALLPRO_LINK: INVOICE_TOKEN }).problem).toBeUndefined();
  });

  it('carries the parse detail only for an invalid registry', () => {
    expect(new LinkRegistry({}).problemDetail).toBeUndefined();
    expect(new LinkRegistry({ HOUSECALLPRO_LINK: 'nope' }).problemDetail).toMatch(
      /Not a Housecall Pro customer link/,
    );
  });

  // Regression: classification must not depend on the wording of resolve()'s
  // error, or rewording that user-facing string silently reclassifies servers.
  it('does not classify by substring-matching resolve() prose', () => {
    const reg = new LinkRegistry({});
    let prose = '';
    try {
      reg.resolve();
    } catch (err) {
      prose = (err as Error).message;
    }
    expect(prose).toMatch(/No Housecall Pro customer link configured/);
    expect(reg.problem).toBe('unset');
  });
});
