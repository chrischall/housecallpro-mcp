import { describe, expect, it } from 'vitest';
import { HousecallProClient } from '../src/client.js';
import { LinkRegistry } from '../src/links.js';
import { registerEstimateTools } from '../src/tools/estimates.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

/**
 * Every tool classifies itself, read off the REGISTERED config rather than a
 * hand-kept list. `destructiveHint` defaults to TRUE whenever readOnlyHint is
 * false, and an absent `openWorldHint` defaults to true — so a forgotten hint
 * and a considered one are indistinguishable unless something checks.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

function registeredAnnotations(): Record<string, Ann | undefined> {
  const seen: Record<string, Ann | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Ann }) => {
      seen[name] = cfg.annotations;
    },
  } as never;
  const client = new HousecallProClient(new LinkRegistry({}));
  registerEstimateTools(server, client);
  registerHealthcheckTools(server, client);
  return seen;
}

describe('every tool declares its annotations', () => {
  it('registers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(registeredAnnotations())).toHaveLength(7);
  });

  it('sets an explicit boolean readOnlyHint on all of them', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('sets an explicit boolean openWorldHint on all of them', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.openWorldHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('marks only the purely local tools closed-world', () => {
    // list_links reads the env-configured registry; approve_estimate always
    // refuses before any request. Neither touches the network.
    const local = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.openWorldHint === false)
      .map(([name]) => name)
      .sort();
    expect(local).toEqual(['housecallpro_approve_estimate', 'housecallpro_list_links']);
  });

  it('keeps decline destructive: it notifies the contractor and has no inverse here', () => {
    expect(registeredAnnotations()['housecallpro_decline_estimate']).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});
