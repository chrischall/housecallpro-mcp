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
import {
  ApiError,
  EdgeBlockedError,
  McpToolError,
  UpstreamFormatError,
  createApiClient,
  fetchBounded,
  messageOf,
  type ApiClient,
} from '@chrischall/mcp-utils';
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

/** Per-attempt budget for any call, covering the body as well as the headers. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Largest response body read. A real estimate or invoice document is tens of
 * kB; this only stops a runaway body from being held in memory.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Told to the model when a decline was sent but its outcome is unknown. */
const DECLINE_OUTCOME_HINT =
  'Re-read the estimate with housecallpro_get_estimate to see whether the decline landed before trying again.';

export interface HousecallProClientOptions {
  fetchImpl?: typeof fetch;
  /** Per-call timeout in ms (tests). Defaults to {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
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
  private readonly timeoutMs: number;
  /**
   * The shared fleet client (mcp-utils): per-attempt timeout covering the
   * body, the caller's cancellation, a body cap, same-origin redirects, edge-
   * block detection, and WriteOutcomeUnknownError for a sent-but-unanswered
   * decline. No `getToken`: reads carry the token in the path and the decline
   * sends its own `Authorization: Token …` header.
   */
  private readonly api: ApiClient;
  /** link URL -> resolved long token, so a short link costs one redirect per client. */
  private readonly resolved = new Map<string, string>();

  constructor(
    readonly links: LinkRegistry,
    opts: HousecallProClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.api = createApiClient({
      baseUrl: API_ORIGIN,
      baseHeaders: this.baseHeaders(),
      serviceName: 'Housecall Pro',
      timeout: this.timeoutMs,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      redirect: 'same-origin',
      fetchImpl: (input, init) => this.fetchImpl(input, init),
      onUnauthorized: () => linkRejected(401),
      writeOutcomeHint: DECLINE_OUTCOME_HINT,
    });
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

    const form = new URLSearchParams();
    for (const uuid of optionUuids) form.append('estimate_option_uuids[]', uuid);

    return this.request('POST', '/api/estimates/estimate_options/customer_declines', {
      headers: { authorization: `Token ${token}` },
      form,
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

    // A different origin from the API (the short-link host), and the 301 is
    // the answer, so this one call is a bounded fetch rather than the client.
    let res: Response;
    try {
      ({ res } = await fetchBounded(
        shortUrl,
        { redirect: 'manual', headers: this.baseHeaders() },
        {
          read: 'none',
          timeoutMs: this.timeoutMs,
          service: 'Housecall Pro',
          fetchImpl: (input, init) => this.fetchImpl(input, init),
        },
      ));
    } catch (err) {
      throw unreachable(err);
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
    return this.request('GET', path, {});
  }

  /**
   * One API call through the shared client, with this repo's wording for the
   * statuses a customer link produces. Errors the shared client already words
   * well — a timeout, an outcome-unknown write, an edge block, an oversized
   * body, a cancellation — pass through unchanged.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { headers?: Record<string, string>; form?: URLSearchParams },
  ): Promise<Record<string, unknown>> {
    try {
      return await this.api.fetchJson<Record<string, unknown>>(method, path, opts);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  private mapError(err: unknown): Error {
    if (err instanceof EdgeBlockedError) return err;
    if (err instanceof UpstreamFormatError) {
      return new McpToolError(
        'Housecall Pro returned an unexpected non-JSON response. ' +
          'This usually means the link is no longer valid.',
      );
    }
    if (err instanceof ApiError) {
      // Deliberately not SessionNotAuthenticatedError: there is no session and
      // nothing to sign in to. A 401/403 here means the link itself is spent.
      if (err.status === 403) return linkRejected(403);
      if (err.status === 404) {
        return new McpToolError(
          'Housecall Pro says this document no longer exists (HTTP 404). A pro can delete ' +
            'or re-issue a document, which invalidates the old link.',
        );
      }
      return new McpToolError(`Housecall Pro returned HTTP ${err.status}.`);
    }
    return unreachable(err);
  }
}

/** A 401/403 on a customer link: it has expired or been revoked. */
function linkRejected(status: number): McpToolError {
  return new McpToolError(
    `Housecall Pro rejected the customer link (HTTP ${status}). The link has expired ` +
      'or been revoked — ask your pro to resend it, then use the new link.',
  );
}

/**
 * A failure before any answer. Typed errors from the shared kit (timeout,
 * outcome-unknown, cancellation, too-large) keep their own message and kind;
 * only a raw transport throw becomes "could not reach".
 */
function unreachable(err: unknown): Error {
  if (err instanceof McpToolError || (err instanceof Error && err.name !== 'Error' && err.name !== 'TypeError')) {
    return err;
  }
  return new McpToolError(`Could not reach housecallpro.com: ${messageOf(err)}`);
}
