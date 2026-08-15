/**
 * Boots the REAL built artifacts and drives the MCP handshake over stdio.
 *
 * Two things only this test can catch:
 *  - `dist/bundle.js` is what ships inside the `.mcpb`, which carries no
 *    `node_modules`. Running it from a temp dir with none proves nothing is
 *    eagerly imported that the bundle does not contain.
 *  - `dist/index.js` is the `bin` entry. A wrong `rootDir` emits it at
 *    `dist/src/index.js` and every `npx` launch fails; unit tests never see it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(root, 'dist', 'bundle.js');
const BIN = join(root, 'dist', 'index.js');

/** Run the initialize + tools/list handshake against a built entry point. */
async function handshake(entry: string, cwd: string): Promise<string[]> {
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // No link configured on purpose: the server must still boot and answer
    // tools/list, which is exactly what a host does at install time.
    env: { ...process.env, HOUSECALLPRO_LINK: '', HOUSECALLPRO_LINKS: '' },
  });

  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'boot-test', version: '0' },
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString();
    if (stdout.includes('"id":1') && !stdout.includes('"id":2')) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }
  });
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString();
  });

  const names = await new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out. stderr:\n${stderr}\nstdout:\n${stdout}`));
    }, 20_000);

    child.stdout.on('data', () => {
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result.tools.map((t) => t.name));
          return;
        }
      }
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited early (code ${code}). stderr:\n${stderr}`));
    });
  });

  return names;
}

describe.runIf(existsSync(BUNDLE) && existsSync(BIN))('built server boots', () => {
  // Count, not roster: PR CI builds the branch merged with main, so a hardcoded
  // length breaks the moment another PR adds a tool. index.test.ts owns the
  // exact roster on its own branch.
  it('serves tools from dist/bundle.js with no node_modules present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcp-mcpb-'));
    copyFileSync(BUNDLE, join(dir, 'bundle.js'));

    const names = await handshake(join(dir, 'bundle.js'), dir);

    expect(names.length).toBeGreaterThanOrEqual(7);
    expect(names).toContain('housecallpro_get_estimate');
  }, 30_000);

  it('serves tools from the bin entry with node_modules present', async () => {
    const names = await handshake(BIN, root);

    expect(names.length).toBeGreaterThanOrEqual(7);
    expect(names).toContain('housecallpro_healthcheck');
  }, 30_000);
});
