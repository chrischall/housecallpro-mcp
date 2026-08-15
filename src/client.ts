/**
 * Housecall Pro consumer client.
 *
 * Everything here is plain server-side `fetch` against `app.housecallpro.com`.
 * The consumer API is not bot-walled — a bare `curl` gets a 200 — so unlike the
 * realty cohort this repo needs no browser bridge, and hosts cleanly.
 *
 * Auth is a per-document retrieval token, placed two different ways depending
 * on the call. Reads put it in the path and send no `Authorization` header at
 * all; writes send `Authorization: Token <token>` and name the subject in the
 * body. That asymmetry is the API's, not ours — see docs/HOUSECALLPRO-API.md.
 */
import { McpToolError, messageOf } from '@chrischall/mcp-utils';
import {
  API_ORIGIN,
  RETRIEVAL_TOKEN_RE,
  parseLink,
  tokenShape,
  type HousecallLink,
  type LinkRegistry,
  type ParsedLink,
} from './links.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The SPA sends this on every call. It carries no identity — it is a
 * base64 blob naming the platform — but sending what the client sends keeps us
 * off any heuristic that notices its absence.
 */
const DEVICE_CONTEXT = Buffer.from(
  JSON.stringify({ os: { name: 'Web' }, userAgent: 'housecallpro-mcp' }),
).toString('base64');

/**
 * Is this argument an attempt at a link, rather than a registry label?
 *
 * Deliberately loose: a URL, anything naming the service's domain, or a long
 * hex/underscore run (a retrieval token, well-formed or not). Labels are short
 * human words like `tankless`, so they cannot collide with any of these.
 */
function looksLikeLinkAttempt(value: string): boolean {
  const v = value.trim();
  return (
    /^https?:\/\//i.test(v) || /housecallpro\.com/i.test(v) || /^[0-9a-f_]{20,}$/i.test(v)
  );
}

export interface HousecallProClientOptions {
  fetchImpl?: typeof fetch;
}

/** Loose: only the fields we read are named, so an upstream addition can't break us. */
export interface EstimateResponse {
  estimate: { data: Record<string, unknown> };
  options: { data: Record<string, unknown>[] };
  [key: string]: unknown;
}

/** The consumer invoice document. Flat — no `{object, data}` wrappers. */
export interface InvoiceResponse {
  [key: string]: unknown;
}

export class HousecallProClient {
  private readonly fetchImpl: typeof fetch;
  /** link URL -> resolved long token, so a short link costs one redirect per client. */
  private readonly resolved = new Map<string, string>();

  constructor(
    readonly links: LinkRegistry,
    opts: HousecallProClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /**
   * The long retrieval token for a link, following a short link's 301 once.
   *
   * `linkOrLabel` is a real link (a pasted URL or a bare token) when it parses
   * as one, and otherwise a label into the configured registry. Links come
   * first because they are unambiguous: a Housecall Pro link cannot be mistaken
   * for a label, but a label could shadow a link the caller actually meant.
   *
   * Accepting a link per call is what makes this server usable with nothing
   * configured — which is the normal case, since Housecall Pro issues a
   * separate disposable link per document and there is no standing one to put
   * in an environment variable.
   */
  async tokenFor(linkOrLabel?: string): Promise<string> {
    const link = this.linkFor(linkOrLabel);
    if (link.token) return link.token;

    const key = link.shortUrl as string;
    const cached = this.resolved.get(key);
    if (cached) return cached;

    const token = await this.followShortLink(link);
    this.resolved.set(key, token);
    return token;
  }

  /**
   * A pasted link if it parses as one, else a lookup in the configured registry.
   *
   * The distinction is made BEFORE parsing, not by catching a parse failure.
   * Swallowing the failure would replace `parseLink`'s specific diagnosis —
   * "Refusing a link on evil.example.com" — with a generic "no link
   * configured" or, worse, an "Unknown link \"<the url>\"" that echoes the
   * offending URL back. So anything that is evidently an attempt at a link
   * gets `parseLink`'s error verbatim; only a plain word can be a label.
   */
  private linkFor(linkOrLabel?: string): HousecallLink {
    if (linkOrLabel && looksLikeLinkAttempt(linkOrLabel)) {
      return { label: 'inline', ...parseLink(linkOrLabel) };
    }
    return this.links.resolve(linkOrLabel);
  }

  /**
   * Whether a configured link addresses an invoice rather than an estimate.
   *
   * Shape-based, so it works for a bare token whose URL never said which kind
   * it was. Resolving a short link can hit the network, so this is async.
   */
  async isInvoiceLink(selector?: string): Promise<boolean> {
    return tokenShape(await this.tokenFor(selector)) === 'invoice';
  }

  /** Full estimate document behind a customer link. */
  async getEstimate(selector?: string): Promise<EstimateResponse> {
    const token = await this.tokenFor(selector);
    this.assertShape(token, 'estimate', selector);
    const body = await this.getJson(`/alpha/customer_estimates/${encodeURIComponent(token)}`);
    return body as unknown as EstimateResponse;
  }

  /**
   * Full invoice document behind a customer link.
   *
   * Note the `v1` segment: `/api/invoices/consumer/invoices/<token>` (without
   * it) 404s. Both paths appear in the SPA's bundles; only this one answers.
   */
  async getInvoice(selector?: string): Promise<InvoiceResponse> {
    const token = await this.tokenFor(selector);
    this.assertShape(token, 'invoice', selector);
    return this.getJson(`/api/invoices/consumer/v1/invoices/${encodeURIComponent(token)}`);
  }

  /**
   * Catch a token pointed at the wrong endpoint before spending a request.
   *
   * Estimate and invoice tokens have visibly different shapes, so using an
   * invoice link with `get_estimate` is detectable up front — and reporting it
   * as "wrong tool" beats the bare 404 the upstream would return.
   */
  private assertShape(token: string, want: 'estimate' | 'invoice', selector?: string): void {
    const got = tokenShape(token);
    if (!got || got === want) return;

    const named = selector && !looksLikeLinkAttempt(selector) ? `Link "${selector}"` : 'That link';
    const right = got === 'invoice' ? 'housecallpro_get_invoice' : 'housecallpro_get_estimate';
    throw new McpToolError(
      `${named} is ${got === 'invoice' ? 'an invoice' : 'an estimate'} link, not ` +
        `${want === 'invoice' ? 'an invoice' : 'an estimate'} one. Use ${right} instead.`,
    );
  }

  /** Public company record. The uuid comes from an estimate's `organization_id`. */
  async getOrganization(organizationId: string): Promise<Record<string, unknown>> {
    if (!UUID_RE.test(organizationId)) {
      throw new McpToolError(
        'organization_id must be a UUID — take it from an estimate\'s `organization_id` field.',
      );
    }
    return this.getJson(`/alpha/organizations/${organizationId}`);
  }

  /**
   * Decline one or more estimate options.
   *
   * The only mutation this server can actually perform: unlike approval, the
   * decline path carries no captcha token.
   */
  async declineOptions(optionUuids: string[], selector?: string): Promise<Record<string, unknown>> {
    if (optionUuids.length === 0) {
      throw new McpToolError('Pass at least one estimate option uuid to decline.');
    }
    const token = await this.tokenFor(selector);
    // Without this, an invoice token gets posted to the estimate decline
    // endpoint and the resulting 401 is reported as "your link expired",
    // sending the user after the wrong problem.
    this.assertShape(token, 'estimate', selector);

    const body = new URLSearchParams();
    for (const uuid of optionUuids) body.append('estimate_option_uuids[]', uuid);

    return this.request('/api/estimates/estimate_options/customer_declines', {
      method: 'POST',
      headers: {
        authorization: `Token ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  }

  /**
   * Approving is not automatable, and this says so rather than failing oddly.
   *
   * `POST /api/estimates/estimate_options/customer_approvals` requires
   * `response_token`, a reCAPTCHA v3 token minted in-page for the action
   * `estimates_customer_approvals`. No server-side client can produce one, and
   * neither can the fetchproxy bridge — it issues `fetch` calls, it does not
   * run page JS. Rather than post a request that will be rejected (or, worse,
   * might not be, and would then bind the user to a price), refuse here.
   */
  async approveOptions(_optionUuids: string[], _selector?: string): Promise<never> {
    throw new McpToolError(
      'Approving an estimate cannot be automated. Housecall Pro gates approval behind a ' +
        'reCAPTCHA token that only the real page can mint, so this server will not attempt ' +
        'it. Open the estimate link in a browser and press Approve there. ' +
        'Declining an estimate is not gated and is available as housecallpro_decline_estimate.',
    );
  }

  private async followShortLink(link: HousecallLink): Promise<string> {
    const shortUrl = link.shortUrl;
    /* c8 ignore next 3 -- a link has a token or a shortUrl; this guards the type only. */
    if (!shortUrl) {
      throw new McpToolError(`Link "${link.label}" has neither a token nor a short URL.`);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(shortUrl, { redirect: 'manual', headers: this.baseHeaders() });
    } catch (err) {
      throw new McpToolError(`Could not reach housecallpro.com: ${messageOf(err)}`);
    }

    const location = res.headers.get('location') ?? '';
    const tail = location.split('?')[0]?.split('/').filter(Boolean).pop() ?? '';
    if (!RETRIEVAL_TOKEN_RE.test(tail)) {
      throw new McpToolError(
        `Could not resolve that short link (HTTP ${res.status}). ` +
          'Short links expire — ask your pro to resend it, or paste the full ' +
          'client.housecallpro.com link instead.',
      );
    }
    return tail;
  }

  private baseHeaders(): Record<string, string> {
    return {
      accept: 'application/json',
      'segment-device-context': DEVICE_CONTEXT,
      origin: 'https://client.housecallpro.com',
      referer: 'https://client.housecallpro.com/',
    };
  }

  private async getJson(path: string): Promise<Record<string, unknown>> {
    return this.request(path, { method: 'GET' });
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const url = `${API_ORIGIN}${path}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: { ...this.baseHeaders(), ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      throw new McpToolError(`Could not reach housecallpro.com: ${messageOf(err)}`);
    }

    // Deliberately not SessionNotAuthenticatedError: there is no session and
    // nothing to sign in to. A 401 here means the link itself is spent.
    if (res.status === 401 || res.status === 403) {
      throw new McpToolError(
        `Housecall Pro rejected the customer link (HTTP ${res.status}). The link has expired ` +
          'or been revoked — ask your pro to resend it, then update HOUSECALLPRO_LINK.',
      );
    }

    if (res.status === 404) {
      throw new McpToolError(
        'Housecall Pro says this document no longer exists (HTTP 404). A pro can delete ' +
          'or re-issue a document, which invalidates the old link.',
      );
    }

    if (!res.ok) {
      throw new McpToolError(`Housecall Pro returned HTTP ${res.status}.`);
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new McpToolError(
        `Housecall Pro returned an unexpected non-JSON response (HTTP ${res.status}, ` +
          `${text.length} bytes). This usually means the link is no longer valid.`,
      );
    }
  }
}
