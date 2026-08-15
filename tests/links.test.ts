import { describe, expect, it } from 'vitest';
import { LinkRegistry, parseLink, RETRIEVAL_TOKEN_RE } from '../src/links.js';

/** Synthetic token of the real shape: two 64-char hex halves joined by `_`. */
const TOKEN_A = `${'a'.repeat(64)}_${'b'.repeat(64)}`;
const TOKEN_B = `${'c'.repeat(64)}_${'d'.repeat(64)}`;

describe('parseLink', () => {
  it('accepts a bare retrieval token', () => {
    expect(parseLink(TOKEN_A)).toEqual({ kind: 'unknown', token: TOKEN_A });
  });

  it('reads the token and kind out of a client portal URL', () => {
    expect(parseLink(`https://client.housecallpro.com/estimates/${TOKEN_A}`)).toEqual({
      kind: 'estimate',
      token: TOKEN_A,
    });
    expect(parseLink(`https://client.housecallpro.com/invoices/${TOKEN_A}`)).toEqual({
      kind: 'invoice',
      token: TOKEN_A,
    });
    expect(parseLink(`https://client.housecallpro.com/service_agreement/${TOKEN_A}`)).toEqual({
      kind: 'service_agreement',
      token: TOKEN_A,
    });
  });

  it('tolerates the singular /estimate/ route and a trailing slash', () => {
    expect(parseLink(`https://client.housecallpro.com/estimate/${TOKEN_A}/`)).toEqual({
      kind: 'estimate',
      token: TOKEN_A,
    });
  });

  it('keeps a short pro link unresolved — the 301 needs the network', () => {
    expect(parseLink('https://pro.housecallpro.com/mobile_estimate/Ex4mpl3Cod')).toEqual({
      kind: 'estimate',
      shortUrl: 'https://pro.housecallpro.com/mobile_estimate/Ex4mpl3Cod',
    });
  });

  it('rejects a foreign host rather than trusting a pasted URL', () => {
    expect(() => parseLink(`https://evil.example.com/estimates/${TOKEN_A}`)).toThrow(
      /housecallpro\.com/,
    );
  });

  it('rejects something that is neither a URL nor a token', () => {
    expect(() => parseLink('not-a-link')).toThrow(/retrieval token/i);
  });

  it('rejects a token of the wrong shape', () => {
    expect(() => parseLink('abc_def')).toThrow(/retrieval token/i);
    expect(RETRIEVAL_TOKEN_RE.test(TOKEN_A)).toBe(true);
    expect(RETRIEVAL_TOKEN_RE.test('abc_def')).toBe(false);
  });
});

describe('LinkRegistry', () => {
  it('is empty, not broken, with no configuration', () => {
    const reg = new LinkRegistry({});
    expect(reg.configured).toBe(false);
    expect(reg.list()).toEqual([]);
  });

  it('defers the no-config error to resolve() so the server still boots', () => {
    const reg = new LinkRegistry({});
    expect(() => reg.resolve()).toThrow(/HOUSECALLPRO_LINK/);
  });

  it('loads a single link from HOUSECALLPRO_LINK', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINK: `https://client.housecallpro.com/estimates/${TOKEN_A}`,
    });
    expect(reg.configured).toBe(true);
    expect(reg.list()).toEqual([{ label: 'default', kind: 'estimate', isDefault: true }]);
    expect(reg.resolve().token).toBe(TOKEN_A);
  });

  it('honours HOUSECALLPRO_LINK_LABEL', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINK: TOKEN_A,
      HOUSECALLPRO_LINK_LABEL: 'tankless',
    });
    expect(reg.list()[0]?.label).toBe('tankless');
  });

  it('loads several links from HOUSECALLPRO_LINKS as JSON', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINKS: JSON.stringify([
        { label: 'tankless', url: `https://client.housecallpro.com/estimates/${TOKEN_A}` },
        { label: 'hvac', url: TOKEN_B },
      ]),
    });
    expect(reg.list()).toEqual([
      { label: 'tankless', kind: 'estimate', isDefault: true },
      { label: 'hvac', kind: 'unknown', isDefault: false },
    ]);
  });

  it('resolves by label, case-insensitively, and defaults to the first', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINKS: JSON.stringify([
        { label: 'tankless', url: TOKEN_A },
        { label: 'hvac', url: TOKEN_B },
      ]),
    });
    expect(reg.resolve().token).toBe(TOKEN_A);
    expect(reg.resolve('HVAC').token).toBe(TOKEN_B);
  });

  it('names the configured labels when the selector is unknown', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINKS: JSON.stringify([{ label: 'tankless', url: TOKEN_A }]),
    });
    expect(() => reg.resolve('nope')).toThrow(/tankless/);
  });

  it('never exposes a token through list()', () => {
    const reg = new LinkRegistry({ HOUSECALLPRO_LINK: TOKEN_A });
    expect(JSON.stringify(reg.list())).not.toContain(TOKEN_A);
  });

  it('reports malformed JSON as a config error on first use, not at construction', () => {
    const reg = new LinkRegistry({ HOUSECALLPRO_LINKS: '{oops' });
    expect(reg.configured).toBe(false);
    expect(() => reg.resolve()).toThrow(/valid JSON/);
  });

  it('rejects a links entry missing a field', () => {
    const reg = new LinkRegistry({ HOUSECALLPRO_LINKS: JSON.stringify([{ label: 'x' }]) });
    expect(() => reg.resolve()).toThrow(/"label" and a "url"/);
  });

  it('surfaces a bad token in config with the offending label named', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINKS: JSON.stringify([{ label: 'broken', url: 'not-a-link' }]),
    });
    expect(() => reg.resolve()).toThrow(/broken/);
  });

  it('does not leak the token value into a config error message', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINKS: JSON.stringify([{ label: 'broken', url: `${TOKEN_A}xyz` }]),
    });
    expect(() => reg.resolve()).toThrow();
    try {
      reg.resolve();
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN_A);
    }
  });

  it('lets a later duplicate label lose to the first', () => {
    const reg = new LinkRegistry({
      HOUSECALLPRO_LINK: TOKEN_A,
      HOUSECALLPRO_LINKS: JSON.stringify([{ label: 'default', url: TOKEN_B }]),
    });
    expect(reg.list()).toHaveLength(1);
    expect(reg.resolve().token).toBe(TOKEN_A);
  });
});
