#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { HousecallProClient } from './client.js';
import { LinkRegistry } from './links.js';
import { registerEstimateTools } from './tools/estimates.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { VERSION } from './version.js';

// Built here, not inside runMcp, so the deferred-config-error pattern holds:
// the server still boots (and answers the host's install-time tools/list probe)
// with no link configured — the error surfaces on the first tool call.
const client = new HousecallProClient(new LinkRegistry());

await runMcp({
  name: 'housecallpro-mcp',
  version: VERSION,
  banner:
    '[housecallpro-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [registerEstimateTools, registerHealthcheckTools],
});
