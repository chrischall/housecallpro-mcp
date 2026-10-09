import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const plugin = JSON.parse(
  readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>;

describe('.claude-plugin/plugin.json', () => {
  // Claude Code reads the MCP config from `mcpServers`; an `mcp` key is
  // ignored at load time (`claude plugin validate`: "Unknown field 'mcp'").
  it('declares its MCP config under mcpServers, not mcp', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin['mcpServers']).toBe('./.mcp.json');
  });

  it('points mcpServers at a file that exists', () => {
    expect(existsSync(join(root, plugin['mcpServers'] as string))).toBe(true);
  });
});
