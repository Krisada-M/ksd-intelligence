/**
 * The YAML subset learnings use: `key: value` scalars, one level of nested map (`anchor:`),
 * full-line `#` comments. Values are plain words or double-quoted JSON strings. Anything else
 * (lists, flow maps, anchors, multi-line scalars, tabs) is a parse error, so a file is either
 * read exactly or skipped — never half-understood.
 */
export type YamlMap = Record<string, string | Record<string, string>>;

export type YamlResult = { ok: true; value: YamlMap } | { ok: false; message: string };

export const MAX_YAML_BYTES = 16 * 1024;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const PLAIN_RE = /^[^\s"'[\]{}&*!|>%@`#,][^#]*$/;

function scalar(
  raw: string,
  line: number,
): { ok: true; value: string } | { ok: false; message: string } {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string') return { ok: true, value: parsed };
    } catch {
      // Falls through to the error below.
    }
    return { ok: false, message: `line ${line}: invalid double-quoted string` };
  }
  if (!PLAIN_RE.test(text)) {
    return { ok: false, message: `line ${line}: unsupported value; use a double-quoted string` };
  }
  return { ok: true, value: text.trimEnd() };
}

export function parseYamlSubset(text: string): YamlResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_YAML_BYTES) {
    return { ok: false, message: `file larger than ${MAX_YAML_BYTES} bytes` };
  }
  const out: YamlMap = {};
  let nested: Record<string, string> | null = null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? '';
    if (line.includes('\t')) return { ok: false, message: `line ${lineNo}: tab character` };
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indented = line.startsWith('  ');
    if (indented && nested === null) {
      return { ok: false, message: `line ${lineNo}: unexpected indentation` };
    }
    const body = indented ? line.slice(2) : line;
    if (body.startsWith(' '))
      return { ok: false, message: `line ${lineNo}: nesting deeper than one level` };
    const colon = body.indexOf(':');
    if (colon < 0) return { ok: false, message: `line ${lineNo}: expected "key: value"` };
    const key = body.slice(0, colon);
    if (!KEY_RE.test(key)) return { ok: false, message: `line ${lineNo}: invalid key "${key}"` };
    const rest = body.slice(colon + 1);
    const target: Record<string, unknown> = indented && nested !== null ? nested : out;
    if (key in target) return { ok: false, message: `line ${lineNo}: duplicate key "${key}"` };
    if (!indented) nested = null;
    if (rest.trim() === '') {
      if (indented) return { ok: false, message: `line ${lineNo}: nesting deeper than one level` };
      nested = {};
      out[key] = nested;
      continue;
    }
    if (!rest.startsWith(' '))
      return { ok: false, message: `line ${lineNo}: expected a space after ":"` };
    const value = scalar(rest, lineNo);
    if (!value.ok) return value;
    if (indented && nested !== null) nested[key] = value.value;
    else out[key] = value.value;
  }
  return { ok: true, value: out };
}

/** Writes values double-quoted, so whatever a claim contains reads back as the same string. */
export function serializeYamlSubset(
  entries: readonly [string, string | readonly [string, string][]][],
): string {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    lines.push(`${key}:`);
    for (const [inner, innerValue] of value)
      lines.push(`  ${inner}: ${JSON.stringify(innerValue)}`);
  }
  return `${lines.join('\n')}\n`;
}
