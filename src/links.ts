/**
 * Customer link configuration.
 *
 * A Housecall Pro customer link is per-document, not per-account: the pro sends
 * one link per estimate or invoice, and nothing spans them. So the server holds
 * a *list* of links and every tool takes an optional selector; with one link
 * configured the selector is never needed.
 *
 * The retrieval token is a bearer credential — anyone holding it can read the
 * document — so it is read from the environment, never logged, and never echoed
 * back in a tool result.
 */
import { McpToolError, messageOf, readEnvVar } from '@chrischall/mcp-utils';

export const CLIENT_ORIGIN = 'https://client.housecallpro.com';
export const API_ORIGIN = 'https://app.housecallpro.com';
export const SHORT_ORIGIN = 'https://pro.housecallpro.com';

/**
 * Retrieval tokens come in two shapes, and they are not interchangeable.
 *
 * Estimates use two 64-char lowercase hex halves joined by `_` (129 chars);
 * invoices use a bare 32-char lowercase hex string. Both verified against live
 * links. They address different endpoints — see `HousecallProClient` — so the
 * shape is worth keeping distinguishable rather than collapsing into one regex.
 */
export const ESTIMATE_TOKEN_RE = /^[0-9a-f]{64}_[0-9a-f]{64}$/;
export const INVOICE_TOKEN_RE = /^[0-9a-f]{32}$/;

/** Either shape. */
export const RETRIEVAL_TOKEN_RE = /^(?:[0-9a-f]{64}_[0-9a-f]{64}|[0-9a-f]{32})$/;

/** Which endpoint family a token's shape implies, when the URL didn't say. */
export function tokenShape(token: string): 'estimate' | 'invoice' | undefined {
  if (ESTIMATE_TOKEN_RE.test(token)) return 'estimate';
  if (INVOICE_TOKEN_RE.test(token)) return 'invoice';
  return undefined;
}

/** What a link points at. `unknown` is a bare token, whose kind the URL didn't say. */
export type LinkKind = 'estimate' | 'invoice' | 'service_agreement' | 'add_tip' | 'unknown';

export interface ParsedLink {
  kind: LinkKind;
  /** Present when the long retrieval token is already known. */
  token?: string;
  /** Present instead of `token` for a short pro link — resolving it needs a 301. */
  shortUrl?: string;
}

export interface HousecallLink extends ParsedLink {
  label: string;
}

/** SPA route segment -> what the document is. */
const ROUTE_KINDS: Record<string, LinkKind> = {
  estimate: 'estimate',
  estimates: 'estimate',
  invoice: 'invoice',
  invoices: 'invoice',
  service_agreement: 'service_agreement',
  add_tip: 'add_tip',
  pay_invoice: 'invoice',
  pay_deposit: 'invoice',
};

/** Short-link prefixes on pro.housecallpro.com, and what they lead to. */
const SHORT_KINDS: Record<string, LinkKind> = {
  mobile_estimate: 'estimate',
  mobile_invoice: 'invoice',
};

/**
 * Turn whatever the user pasted into a link we can act on.
 *
 * Accepts a bare retrieval token, a `client.housecallpro.com` portal URL, or a
 * `pro.housecallpro.com` short link. A short link keeps its URL rather than a
 * token: only a network round-trip can turn it into one, and config parsing
 * must not do IO.
 */
export function parseLink(input: string): ParsedLink {
  const raw = input.trim();
  if (!raw) throw new Error('Empty link.');

  if (RETRIEVAL_TOKEN_RE.test(raw)) return { kind: 'unknown', token: raw };

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('Not a valid URL.');
    }

    if (!/(^|\.)housecallpro\.com$/i.test(url.hostname)) {
      throw new Error(
        `Refusing a link on ${url.hostname} — customer links live on housecallpro.com.`,
      );
    }

    const segments = url.pathname.split('/').filter(Boolean);
    // Default to '' rather than branching on undefined: neither lookup table
    // has an empty key, so a pathless URL falls through the same way a
    // "/pricing" one does.
    const head = segments[0] ?? '';
    const tail = segments[segments.length - 1] ?? '';

    const shortKind = SHORT_KINDS[head];
    if (shortKind && segments.length >= 2) {
      return { kind: shortKind, shortUrl: url.toString() };
    }

    if (RETRIEVAL_TOKEN_RE.test(tail)) {
      return { kind: ROUTE_KINDS[head] ?? 'unknown', token: tail };
    }

    // A housecallpro.com URL we don't recognise: treat the last segment as a
    // short code only when the route says which document it is.
    if (shortKind) {
      return { kind: shortKind, shortUrl: url.toString() };
    }
  }

  throw new Error(
    'Not a Housecall Pro customer link. Paste the link your pro sent you ' +
      '(pro.housecallpro.com/mobile_estimate/… or client.housecallpro.com/estimates/…), ' +
      'or the 129-character retrieval token from the end of it.',
  );
}

/**
 * Config errors are stored, not thrown.
 *
 * The server must still boot with no link configured so the host's install-time
 * `tools/list` probe succeeds; the error surfaces on the first tool call that
 * actually needs a link.
 */
export class LinkRegistry {
  private readonly links: HousecallLink[] = [];
  private readonly configError: string | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    try {
      this.links = loadLinks(env);
    } catch (err) {
      this.configError = messageOf(err);
    }
  }

  /** Configured links. Labels and kinds only — tokens are credentials and stay internal. */
  list(): { label: string; kind: LinkKind; isDefault: boolean }[] {
    return this.links.map((l, i) => ({ label: l.label, kind: l.kind, isDefault: i === 0 }));
  }

  get configured(): boolean {
    return this.links.length > 0;
  }

  /** Resolve a selector to a link; the first configured link is the default. */
  resolve(selector?: string): HousecallLink {
    if (this.configError) throw new McpToolError(this.configError);

    if (this.links.length === 0) {
      throw new McpToolError(
        'No Housecall Pro customer link configured. Set HOUSECALLPRO_LINK to the link ' +
          'your pro emailed or texted you (pro.housecallpro.com/mobile_estimate/… or ' +
          'client.housecallpro.com/estimates/…). For several documents, set ' +
          'HOUSECALLPRO_LINKS to a JSON array like [{"label":"tankless","url":"…"}].',
      );
    }

    if (!selector) return this.links[0] as HousecallLink;

    const wanted = selector.trim().toLowerCase();
    const found = this.links.find((l) => l.label.toLowerCase() === wanted);
    if (found) return found;

    throw new McpToolError(
      `Unknown link "${selector}". Configured: ${this.links.map((l) => l.label).join(', ')}.`,
    );
  }
}

function loadLinks(env: NodeJS.ProcessEnv): HousecallLink[] {
  const links: HousecallLink[] = [];

  const single = readEnvVar('HOUSECALLPRO_LINK', { env });
  if (single) {
    const label = readEnvVar('HOUSECALLPRO_LINK_LABEL', { env }) ?? 'default';
    links.push({ label, ...parseOrName(label, single) });
  }

  const many = readEnvVar('HOUSECALLPRO_LINKS', { env });
  if (many) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(many);
    } catch {
      throw new Error('HOUSECALLPRO_LINKS is not valid JSON. Expected [{"label":"…","url":"…"}].');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('HOUSECALLPRO_LINKS must be a JSON array of {label, url} objects.');
    }
    for (const entry of parsed as (Record<string, unknown> | null)[]) {
      const label = typeof entry?.['label'] === 'string' ? entry['label'] : undefined;
      const url = typeof entry?.['url'] === 'string' ? entry['url'] : undefined;
      if (!label || !url) {
        throw new Error('Every HOUSECALLPRO_LINKS entry needs a "label" and a "url".');
      }
      if (!links.some((l) => l.label === label)) links.push({ label, ...parseOrName(label, url) });
    }
  }

  return links;
}

/**
 * Parse a configured link, naming the label that broke.
 *
 * The underlying message never quotes the input, so a malformed token cannot
 * ride out to the user in an error string.
 */
function parseOrName(label: string, url: string): ParsedLink {
  try {
    return parseLink(url);
  } catch (err) {
    throw new Error(`Link "${label}" is not usable: ${messageOf(err)}`);
  }
}
