import { describe, expect, it } from 'vitest';
import { summarizeEstimate } from '../src/normalize.js';
import type { EstimateResponse } from '../src/client.js';

/**
 * Built from a real captured response, with every identifying value replaced.
 * The *shape* is the part under test, and it is the real one — see
 * docs/HOUSECALLPRO-API.md.
 */
function fixture(): EstimateResponse {
  return {
    object: 'customer_estimate',
    estimate: {
      object: 'customer_estimate',
      data: {
        object: 'estimate',
        id: 'csr_1',
        estimate_uuid: 'csr_1',
        estimate_number: '210132782',
        organization_id: '6e14b390-4b34-4338-a7c2-89d248ca25c8',
        customer_uuid: 'cus_1',
        customer_approval_mode: 'single_option',
        expiration_date: null,
        address: {
          object: 'address',
          data: {
            street: '1 Example St',
            street_line_2: null,
            city: 'Charlotte',
            state: 'NC',
            zip: '28209',
            printable_address: '1 Example St, Charlotte, NC 28209',
            country: 'US',
          },
        },
      },
    },
    options: {
      object: 'list',
      data: [
        {
          object: 'option',
          id: 'est_1',
          name: 'Option #1',
          option_number: '210132782',
          option_date: '2026-08-13',
          status: 'Awaiting Approval',
          approval_date: null,
          service_subtotal: 31999,
          material_subtotal: null,
          sub_total: 31999,
          total_amount: 34639,
          tax: {
            object: 'tax',
            data: { rate: 0.0825, name: 'A-Mecklenburg County', amount: 2640, display_name: 'Tax' },
          },
          line_items: {
            object: 'list',
            data: [
              {
                object: 'line_item',
                id: 'li_1',
                name: 'Tankless Flush and Descale',
                description: 'Run the pump for 45 minutes.',
                unit_price: 31999,
                quantity: 1,
                amount: 31999,
                kind: 'labor',
                order_index: 0,
              },
            ],
          },
          payment_information: { deposit_amount: null, deposit_due_date: null },
        },
      ],
    },
    customer_name: 'Example Customer',
    customer_company_name: null,
    customer_email: null,
    estimate_date: '2026-08-13',
    service_date: null,
    message_from_pro: 'Thanks for your business.',
    deposit_requirement: 'none',
    signatures_enabled: false,
    payment_options: { can_pay_online: true },
    company_name: 'Example Plumbing',
    company_phone_number: '7045551234',
    company_email: 'info@example.com',
    company_website: 'https://example.com',
    company_printable_address: '1 Trade St, Charlotte, NC 28273',
    company_logo_url: 'https://example.com/logo.png',
    company_country: 'US',
  } as unknown as EstimateResponse;
}

describe('summarizeEstimate', () => {
  it('flattens the nested envelope into a flat record', () => {
    const s = summarizeEstimate(fixture());

    expect(s.estimate_number).toBe('210132782');
    expect(s.organization_id).toBe('6e14b390-4b34-4338-a7c2-89d248ca25c8');
    expect(s.customer_approval_mode).toBe('single_option');
    expect(s.customer_name).toBe('Example Customer');
    expect(s.message_from_pro).toBe('Thanks for your business.');
  });

  it('lifts the address out of its {object,data} wrapper', () => {
    expect(summarizeEstimate(fixture()).service_address).toBe('1 Example St, Charlotte, NC 28209');
  });

  it('collects the company block', () => {
    expect(summarizeEstimate(fixture()).company).toEqual({
      name: 'Example Plumbing',
      phone: '7045551234',
      email: 'info@example.com',
      website: 'https://example.com',
      address: '1 Trade St, Charlotte, NC 28273',
    });
  });

  it('projects options with the fields that decide anything', () => {
    const [opt] = summarizeEstimate(fixture()).options;

    expect(opt).toMatchObject({
      id: 'est_1',
      name: 'Option #1',
      status: 'Awaiting Approval',
      approval_date: null,
      total_amount_cents: 34639,
      subtotal_cents: 31999,
    });
  });

  // The API returns integer cents. Reporting them raw overstates every figure
  // 100x, so the derived dollars are asserted explicitly.
  it('converts money from cents to dollars without touching the tax rate', () => {
    const [opt] = summarizeEstimate(fixture()).options;

    expect(opt?.total_amount_usd).toBe(346.39);
    expect(opt?.subtotal_usd).toBe(319.99);
    expect(opt?.tax).toEqual({
      name: 'A-Mecklenburg County',
      rate: 0.0825,
      amount_cents: 2640,
      amount_usd: 26.4,
    });
  });

  it('flattens line items out of their own wrapper', () => {
    const [opt] = summarizeEstimate(fixture()).options;
    expect(opt?.line_items).toEqual([
      {
        name: 'Tankless Flush and Descale',
        description: 'Run the pump for 45 minutes.',
        quantity: 1,
        kind: 'labor',
        unit_price_cents: 31999,
        amount_cents: 31999,
        unit_price_usd: 319.99,
        amount_usd: 319.99,
      },
    ]);
  });

  it('exposes the option id, because declining needs exactly that', () => {
    expect(summarizeEstimate(fixture()).options[0]?.id).toBe('est_1');
  });

  it('reports whether the estimate is still open', () => {
    expect(summarizeEstimate(fixture()).awaiting_approval).toBe(true);
  });

  it('reports an approved estimate as no longer awaiting approval', () => {
    const raw = fixture();
    const opt = raw.options.data[0] as Record<string, unknown>;
    opt['status'] = 'Approved';
    opt['approval_date'] = '2026-08-14';
    const s = summarizeEstimate(raw);
    expect(s.awaiting_approval).toBe(false);
    expect(s.options[0]?.approval_date).toBe('2026-08-14');
  });

  // Undocumented API: degrade rather than emit a confidently wrong projection.
  it('survives an estimate with no options at all', () => {
    const raw = fixture();
    raw.options.data = [];
    const s = summarizeEstimate(raw);
    expect(s.options).toEqual([]);
    expect(s.awaiting_approval).toBe(false);
  });

  it('survives missing nested wrappers rather than throwing', () => {
    const raw = { estimate: { data: {} }, options: { data: [{ id: 'est_1' }] } } as unknown as EstimateResponse;
    const s = summarizeEstimate(raw);
    expect(s.estimate_number).toBeUndefined();
    expect(s.service_address).toBeUndefined();
    expect(s.options[0]?.line_items).toEqual([]);
    expect(s.options[0]?.tax).toBeUndefined();
  });
});
