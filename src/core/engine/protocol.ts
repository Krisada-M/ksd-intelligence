import { StringDecoder } from 'node:string_decoder';
import { isRecord } from '../kernel/guards.js';

// Newline-delimited JSON over the child's stdin/stdout (D45). stdout carries protocol lines only.
export type Message =
  | { type: 'request'; id: string; op: string; args: unknown }
  | { type: 'progress'; id: string; message: string; data?: unknown }
  | { type: 'result'; id: string; value: unknown; retire?: boolean }
  | { type: 'error'; id: string; code: string; message: string };

export function encode(message: Message): string {
  return `${JSON.stringify(message)}\n`;
}

/** Parses one line; returns an error string for anything that is not a well-formed message. */
export function parseMessage(line: string): Message | string {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return 'invalid JSON';
  }
  if (!isRecord(raw) || typeof raw.id !== 'string') return 'message without a string id';
  const { id } = raw;
  if (raw.type === 'request' && typeof raw.op === 'string') {
    return { type: 'request', id, op: raw.op, args: raw.args };
  }
  if (raw.type === 'progress' && typeof raw.message === 'string') {
    return { type: 'progress', id, message: raw.message, data: raw.data };
  }
  if (raw.type === 'result') {
    return { type: 'result', id, value: raw.value, retire: raw.retire === true };
  }
  if (raw.type === 'error' && typeof raw.code === 'string' && typeof raw.message === 'string') {
    return { type: 'error', id, code: raw.code, message: raw.message };
  }
  return `malformed ${String(raw.type)} message`;
}

/** Splits a byte stream into lines; chunks may cut a line or a multi-byte character in half. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  const utf8 = new StringDecoder('utf8');
  let pending = '';
  return (chunk) => {
    const lines = (pending + utf8.write(chunk)).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim() !== '') onLine(line);
  };
}
