import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The `env:` entries of mint.yaml, as `{ name, secret }`. A deliberately tiny
 * reader (no YAML dependency): each entry starts at `- name:` and runs to the
 * next one or to the next top-level key.
 */
function mintEnv(): Array<{ name: string; secret: boolean }> {
  const text = readFileSync(join(root, 'mint.yaml'), 'utf8');
  const envBlock = text.split(/^env:\s*$/m)[1]!.split(/^\S/m)[0]!;
  return envBlock
    .split(/^\s*- name:\s*/m)
    .slice(1)
    .map((chunk) => ({
      name: chunk.split('\n')[0]!.trim(),
      secret: /^\s*secret:\s*true\s*$/m.test(chunk),
    }));
}

describe('mint.yaml', () => {
  // Every customer link embeds a retrieval token, and a retrieval token is a
  // bearer credential: whoever holds it can read the document and decline its
  // options. So every variable whose value can carry one must be secret, or a
  // host stores/displays/logs it as plain config.
  it.each(['HOUSECALLPRO_LINK', 'HOUSECALLPRO_LINKS'])('marks %s secret', (name) => {
    const entry = mintEnv().find((e) => e.name === name);
    expect(entry, `${name} is declared`).toBeDefined();
    expect(entry!.secret).toBe(true);
  });

  it('declares every env var the server reads', () => {
    const src = readFileSync(join(root, 'src/links.ts'), 'utf8');
    const read = [...new Set(src.match(/HOUSECALLPRO_[A-Z_]+/g) ?? [])].sort();
    expect(mintEnv().map((e) => e.name).sort()).toEqual(read);
  });
});
