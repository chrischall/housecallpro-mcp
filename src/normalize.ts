/**
 * Projection of the raw estimate envelope into something an agent can read.
 *
 * The upstream response is ~4.8 KB of JSON:API-flavoured nesting, most of it
 * presentation flags (`show_service_quantity`, `layout`, `feature_flags`). This
 * keeps the fields that decide something and drops the rest — the full document
 * stays reachable through `housecallpro_get_estimate` with `raw: true`.
 *
 * Every accessor tolerates a missing wrapper. This is an undocumented API and
 * it will drift; a summary that degrades beats one that throws.
 */
import type { EstimateResponse } from './client.js';

export interface EstimateLineItem {
  name?: string;
  description?: string;
  quantity?: number;
  kind?: string;
  /** Verbatim from the API: integer cents. */
  unit_price_cents?: number;
  amount_cents?: number;
  /** Derived, so an agent never has to divide — and never forgets to. */
  unit_price_usd?: number;
  amount_usd?: number;
}

export interface EstimateOptionSummary {
  id?: string;
  name?: string;
  option_number?: string;
  option_date?: string;
  status?: string;
  approval_date?: string | null;
  /** Verbatim from the API: integer cents. */
  subtotal_cents?: number;
  total_amount_cents?: number;
  /** Derived dollars. */
  subtotal_usd?: number;
  total_amount_usd?: number;
  /** `rate` is a fraction (0.0825 = 8.25%), NOT cents — never scaled. */
  tax?: { name?: string; rate?: number; amount_cents?: number; amount_usd?: number };
  line_items: EstimateLineItem[];
}

export interface EstimateSummary {
  estimate_number?: string;
  estimate_uuid?: string;
  organization_id?: string;
  customer_approval_mode?: string;
  customer_name?: string;
  customer_email?: string;
  estimate_date?: string;
  service_date?: string;
  expiration_date?: string;
  message_from_pro?: string;
  service_address?: string;
  company: {
    name?: string;
    phone?: string;
    email?: string;
    website?: string;
    address?: string;
  };
  can_pay_online?: boolean;
  signatures_enabled?: boolean;
  deposit_requirement?: string;
  /** True while any option is still open — the thing a user actually asks about. */
  awaiting_approval: boolean;
  options: EstimateOptionSummary[];
}

/** Unwrap a `{object, data}` envelope, returning undefined when it isn't one. */
function unwrap(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const inner = value['data'];
  return isRecord(inner) ? inner : undefined;
}

/** Unwrap a `{object: 'list', data: [...]}` envelope into its array. */
function unwrapList(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const inner = value['data'];
  return Array.isArray(inner) ? inner.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Money arrives as integer cents — verified against a live estimate whose
 * `total_amount` was 34639 for a document the portal renders as $346.39.
 * Reporting that raw would overstate every figure by 100x, so each money field
 * is emitted twice: `*_cents` verbatim and `*_usd` derived.
 *
 * Deliberately NOT applied to `tax.rate`, which is a fraction (0.0825).
 */
function toUsd(value: unknown): number | undefined {
  const cents = num(value);
  return cents === undefined ? undefined : Math.round(cents) / 100;
}

export function summarizeEstimate(raw: EstimateResponse): EstimateSummary {
  const estimate = unwrap(raw['estimate']) ?? {};
  const address = unwrap(estimate['address']) ?? {};
  const options = unwrapList(raw['options']).map(summarizeOption);
  const paymentOptions = isRecord(raw['payment_options']) ? raw['payment_options'] : {};

  return {
    estimate_number: str(estimate['estimate_number']),
    estimate_uuid: str(estimate['estimate_uuid']),
    organization_id: str(estimate['organization_id']),
    customer_approval_mode: str(estimate['customer_approval_mode']),
    customer_name: str(raw['customer_name']),
    customer_email: str(raw['customer_email']),
    estimate_date: str(raw['estimate_date']),
    service_date: str(raw['service_date']),
    expiration_date: str(estimate['expiration_date']),
    message_from_pro: str(raw['message_from_pro']),
    service_address: str(address['printable_address']),
    company: {
      name: str(raw['company_name']),
      phone: str(raw['company_phone_number']),
      email: str(raw['company_email']),
      website: str(raw['company_website']),
      address: str(raw['company_printable_address']),
    },
    can_pay_online: bool(paymentOptions['can_pay_online']),
    signatures_enabled: bool(raw['signatures_enabled']),
    deposit_requirement: str(raw['deposit_requirement']),
    awaiting_approval: options.some((o) => o.approval_date == null && o.status !== 'Declined'),
    options,
  };
}

function summarizeOption(option: Record<string, unknown>): EstimateOptionSummary {
  const tax = unwrap(option['tax']);

  return {
    id: str(option['id']),
    name: str(option['name']),
    option_number: str(option['option_number']),
    option_date: str(option['option_date']),
    status: str(option['status']),
    approval_date: (str(option['approval_date']) ?? null) as string | null,
    subtotal_cents: num(option['sub_total']),
    total_amount_cents: num(option['total_amount']),
    subtotal_usd: toUsd(option['sub_total']),
    total_amount_usd: toUsd(option['total_amount']),
    ...(tax
      ? {
          tax: {
            name: str(tax['name']),
            rate: num(tax['rate']),
            amount_cents: num(tax['amount']),
            amount_usd: toUsd(tax['amount']),
          },
        }
      : {}),
    line_items: unwrapList(option['line_items']).map((item) => ({
      name: str(item['name']),
      description: str(item['description']),
      quantity: num(item['quantity']),
      kind: str(item['kind']),
      unit_price_cents: num(item['unit_price']),
      amount_cents: num(item['amount']),
      unit_price_usd: toUsd(item['unit_price']),
      amount_usd: toUsd(item['amount']),
    })),
  };
}
