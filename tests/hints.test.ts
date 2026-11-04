import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { HousecallProClient } from '../src/client.js';
import { LinkRegistry } from '../src/links.js';
import { registerEstimateTools } from '../src/tools/estimates.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * asserted against the served tool list — what a host actually sees.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, unknown> };
  _meta?: { mint?: Record<string, any> };
};

async function served(): Promise<Listed[]> {
  const client = new HousecallProClient(new LinkRegistry({}));
  const h = await createTestHarness((server) => {
    registerEstimateTools(server, client);
    registerHealthcheckTools(server, client);
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent each tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  housecallpro_get_estimate: 'lookup',
  housecallpro_get_invoice: 'lookup',
  housecallpro_get_company: 'lookup',
  housecallpro_list_links: 'lookup',
  housecallpro_decline_estimate: 'change',
  // Always refuses (approval is reCAPTCHA-gated): it changes nothing.
  housecallpro_approve_estimate: 'other',
};

describe('_meta.mint hints', () => {
  it('every tool except the healthcheck carries domain home and the expected intent', async () => {
    const tools = await served();
    const hinted = tools.filter((t) => !t.name.endsWith('_healthcheck'));
    expect(hinted.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
    for (const t of hinted) {
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(m!.domain, t.name).toBe('home');
      expect(INTENTS, t.name).toContain(m!.intent);
      expect(m!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
    expect(tools.find((t) => t.name === 'housecallpro_healthcheck')?._meta?.mint).toBeUndefined();
  });

  it('aliases are everyday words: at most 8, lowercase, at most 40 chars, never tool names', async () => {
    for (const t of await served()) {
      const aliases = t._meta?.mint?.aliases as string[] | undefined;
      if (!aliases) continue;
      expect(aliases.length, t.name).toBeLessThanOrEqual(8);
      for (const a of aliases) {
        expect(a.length, t.name).toBeLessThanOrEqual(40);
        expect(a, t.name).toBe(a.toLowerCase());
        expect(a, t.name).not.toMatch(/housecallpro_/);
      }
    }
  });

  it('a declared subject or when names arguments that exist in the schema', async () => {
    for (const t of await served()) {
      const m = t._meta?.mint;
      const props = t.inputSchema.properties ?? {};
      if (m?.subject) expect(props, t.name).toHaveProperty(m.subject);
      if (m?.when) {
        expect(Object.keys(m.when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(m.when.start);
        expect(props, t.name).toHaveProperty(m.when.end);
      }
    }
  });

  it('canonical only on read-only whats-new/due/on reads, at most one per intent', async () => {
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical !== undefined);
    for (const t of canonical) {
      expect(t._meta!.mint!.canonical, t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(t._meta!.mint!.intent);
    }
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
  });

  it('declares no canonical read: every read here addresses one document by its link, so none answers "what is new/due/on"', async () => {
    // Housecall Pro has no customer account and no listing: each estimate or
    // invoice is reached only through the disposable link the contractor sent.
    // Nothing can be listed at start, so there is no subject and no feed.
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical);
    expect(canonical.map((t) => t.name)).toEqual([]);
  });

  it('no tool declares a subject: there is no listable set of subjects', async () => {
    for (const t of await served()) expect(t._meta?.mint?.subject, t.name).toBeUndefined();
  });

  it('the document reads carry the words people say about them', async () => {
    const tools = await served();
    const aliases = (name: string) => tools.find((t) => t.name === name)?._meta?.mint?.aliases as string[];
    expect(aliases('housecallpro_get_estimate')).toContain('quote');
    expect(aliases('housecallpro_get_invoice')).toContain('bill');
    expect(aliases('housecallpro_get_company')).toContain('contractor');
  });
});
