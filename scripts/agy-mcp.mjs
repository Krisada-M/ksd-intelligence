#!/usr/bin/env node
import { createStdioServer, resolveMcpRoot } from './mcp/stdio.mjs';

const argv = process.argv.slice(2);
let supplied;
let workflow = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && i + 1 < argv.length && supplied === undefined) {
    supplied = argv[++i];
  } else if (argv[i] === '--workflow') {
    workflow = true;
  } else {
    console.error(
      'usage: node scripts/agy-mcp.mjs --root /absolute/path/to/repository [--workflow]',
    );
    process.exit(2);
  }
}
const resolved = await resolveMcpRoot(supplied, process.env);
if (!resolved.ok) {
  console.error(resolved.message);
  process.exit(2);
}
const env = workflow ? { ...process.env, KSD_MCP_WORKFLOW: '1' } : process.env;
// AGY may spawn MCP servers from its application directory rather than the workspace.
// Root is explicit and frozen for the entire process; tools cannot override it.
createStdioServer({ root: resolved.root, env });
