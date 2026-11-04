/**
 * `_meta.mint` hints (the mcp-host context-groups contract): which canonical
 * group a tool belongs to, what kind of ask it answers, and the everyday words
 * its name and description lack. Inert data to any other client.
 *
 * No tool here is canonical and none names a subject: Housecall Pro has no
 * customer account to list from — every estimate or invoice is reached only
 * through the disposable link the contractor sent — so nothing answers a
 * "what's new / due / on" ask across the person's documents.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'home';
  intent: MintIntent;
  aliases: string[];
}

/** `_meta` for a Housecall Pro tool: every tool here is in the `home` domain. */
export function homeMeta(intent: MintIntent, aliases: string[]): { mint: MintHint } {
  return { mint: { domain: 'home', intent, aliases } };
}
