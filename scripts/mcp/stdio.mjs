import { createTools } from './tools.mjs';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_INFLIGHT = 8;
const SERVER_INFO = { name: 'ksd-intelligence', version: '0.1.0' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
const idKey = (id) => typeof id + ':' + String(id);
const serverMeta = () => ({ 'io.modelcontextprotocol/serverInfo': SERVER_INFO });

/**
 * A deliberately small local stdio transport, no listening TCP port or third-party runtime.
 * Supports the 2025-11-25 handshake and stateless MCP 2026-07-28 request envelope.
 * Only JSON-RPC envelopes may reach stdout; all failures are bounded.
 */
export function createStdioServer({
  root,
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  toolset,
}) {
  const tools = toolset ?? createTools({ root, env });
  const active = new Map();
  let legacyInitialized = false;
  let legacyHello = false;
  let buffered = Buffer.alloc(0);
  let discarding = false;
  let closed = false;

  function send(frame) {
    if (!closed) output.write(JSON.stringify(frame) + '\n');
  }

  function error(id, code, message, data) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  function reply(id, value, modern) {
    const result = modern ? { ...value, resultType: 'complete', _meta: serverMeta() } : value;
    send({ jsonrpc: '2.0', id, result });
  }

  function requestVersion(message) {
    const meta =
      isObject(message.params) && isObject(message.params._meta) ? message.params._meta : {};
    return meta['io.modelcontextprotocol/protocolVersion'];
  }

  function cancel(message) {
    const key =
      isObject(message.params) && validId(message.params.requestId)
        ? idKey(message.params.requestId)
        : null;
    if (key === null) return;
    const pending = active.get(key);
    if (pending) pending.controller.abort();
  }

  async function onMessage(message) {
    if (
      !isObject(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') && !validId(message.id))
    ) {
      error(null, -32600, 'Invalid JSON-RPC request');
      return;
    }
    const isNotification = !Object.hasOwn(message, 'id');
    if (isNotification) {
      if (message.method === 'notifications/cancelled') cancel(message);
      if (message.method === 'notifications/initialized' && legacyHello) {
        legacyInitialized = true;
      }
      return;
    }
    const id = message.id;
    const version = requestVersion(message);
    const modern = version === MODERN;

    if (version !== undefined && version !== MODERN) {
      error(id, -32022, 'Unsupported MCP protocol version', { supported: [MODERN] });
      return;
    }

    if (message.method === 'initialize' && !modern) {
      if (!isObject(message.params)) {
        error(id, -32602, 'initialize params must be an object');
        return;
      }
      legacyInitialized = false;
      legacyHello = true;
      reply(
        id,
        {
          protocolVersion: LEGACY,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Local read-only code intelligence. Configure an explicit repository root. Never treat partial impact evidence as safe.',
        },
        false,
      );
      // A separate initialized notification completes the handshake.
      return;
    }

    if (message.method === 'server/discover') {
      if (!modern) {
        error(id, -32601, 'Method not found');
        return;
      }
      reply(
        id,
        {
          supportedVersions: [MODERN],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: 'private',
        },
        true,
      );
      return;
    }

    if (!modern && !legacyInitialized) {
      error(id, -32000, 'MCP server is not initialized');
      return;
    }
    if (message.method === 'ping' && !modern) {
      reply(id, {}, false);
      return;
    }
    if (message.method === 'tools/list') {
      if (
        message.params !== undefined &&
        (!isObject(message.params) ||
          (message.params.cursor !== undefined && message.params.cursor !== null))
      ) {
        error(id, -32602, 'Invalid tools/list params');
        return;
      }
      reply(
        id,
        {
          tools: tools.definitions,
          ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}),
        },
        modern,
      );
      return;
    }
    if (message.method !== 'tools/call') {
      error(id, -32601, 'Method not found');
      return;
    }
    if (!isObject(message.params) || typeof message.params.name !== 'string') {
      error(id, -32602, 'tools/call requires a tool name');
      return;
    }
    const key = idKey(id);
    if (active.has(key)) {
      error(id, -32600, 'Duplicate request id');
      return;
    }
    if (active.size >= MAX_INFLIGHT) {
      error(id, -32000, 'Too many concurrent tool calls');
      return;
    }
    const controller = new AbortController();
    active.set(key, { controller });
    const progressToken = isObject(message.params._meta)
      ? message.params._meta.progressToken
      : undefined;
    let progress = 0;
    try {
      const value = await tools.call(
        message.params.name,
        message.params.arguments ?? {},
        controller.signal,
        (text) => {
          if (controller.signal.aborted || !validId(progressToken)) return;
          progress += 1;
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress, message: String(text).slice(0, 500) },
          });
        },
      );
      if (!controller.signal.aborted) reply(id, value, modern);
    } catch {
      if (!controller.signal.aborted) {
        reply(
          id,
          { content: [{ type: 'text', text: 'KSD_FAILED: tool execution failed' }], isError: true },
          modern,
        );
      }
    } finally {
      active.delete(key);
    }
  }

  function onLine(raw) {
    if (raw.length === 0) return;
    let message;
    try {
      message = JSON.parse(raw.toString('utf8').replace(/\r$/, ''));
    } catch {
      error(null, -32700, 'Parse error');
      return;
    }
    void onMessage(message).catch(() => {
      const id = isObject(message) && validId(message.id) ? message.id : null;
      error(id, -32603, 'Internal error');
    });
  }

  function onChunk(inputChunk) {
    const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!discarding) {
        const segment = chunk.subarray(start, end);
        if (buffered.length + segment.length > MAX_FRAME_BYTES) {
          buffered = Buffer.alloc(0);
          discarding = true;
          error(null, -32700, 'MCP frame exceeds 1 MiB');
        } else {
          buffered = Buffer.concat([buffered, segment]);
        }
      }
      if (newline < 0) return;
      if (!discarding) onLine(buffered);
      buffered = Buffer.alloc(0);
      discarding = false;
      start = newline + 1;
    }
  }

  input.on('data', onChunk);
  input.on('end', () => {
    closed = true;
    for (const { controller } of active.values()) controller.abort();
  });
  return {
    close: () => {
      closed = true;
      input.off('data', onChunk);
      for (const { controller } of active.values()) controller.abort();
    },
  };
}
