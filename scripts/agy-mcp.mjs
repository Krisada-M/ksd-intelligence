#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createStdioServer } from './mcp/stdio.mjs';
import { loadWorkspace } from '../dist/core/engine/workspace.js';

const argv = process.argv.slice(2);
let supplied;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && i + 1 < argv.length && supplied === undefined) {
    supplied = argv[++i];
  } else {
    console.error('usage: node scripts/agy-mcp.mjs --root /absolute/path/to/repository');
    process.exit(2);
  }
}
const rootPath = supplied ?? process.env.KSD_MCP_ROOT;
if (!rootPath || !isAbsolute(rootPath)) {
  console.error('KSD MCP requires --root or KSD_MCP_ROOT set to an absolute repository directory');
  process.exit(2);
}
let root;
try {
  root = realpathSync(rootPath);
  if (!statSync(root).isDirectory()) throw new Error('not a directory');
} catch {
  console.error('KSD MCP root is not an accessible directory');
  process.exit(2);
}
// KSD's workspace resolver can walk up to a parent git/config root. Refuse implicit
// expansion beyond the root explicitly authorized in the MCP configuration.
try {
  const workspace = await loadWorkspace(root);
  if (workspace.root !== root) throw new Error('subdirectory is not the workspace root');
} catch {
  console.error('KSD MCP root must be the exact accessible KSD workspace root');
  process.exit(2);
}
// AGY may spawn MCP servers from its application directory rather than the workspace.
// Root is explicit and frozen for the entire process; tools cannot override it.
createStdioServer({ root });
