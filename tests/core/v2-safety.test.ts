import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

const SRC = join(process.cwd(), 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // The frozen policy module is out of scope (DESIGN §6.7).
    if (entry.isDirectory() && path !== join(SRC, 'policy')) out.push(...sources(path));
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const NETWORK_RE =
  /from ['"]node:(?:https?|http2|net|tls|dgram)['"]|\bfetch\(|new WebSocket\(|new XMLHttpRequest\(/;

describe('V2 safety sweep (V2-README "Safety rules")', () => {
  it('no network API in src/', () => {
    const hits = sources(SRC).filter((file) => NETWORK_RE.test(readFileSync(file, 'utf8')));
    assert.deepEqual(
      hits.map((file) => relative(SRC, file)),
      [],
    );
  });

  it('no process is started with a shell', () => {
    const hits = sources(SRC).filter((file) => /shell:\s*true/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(
      hits.map((file) => relative(SRC, file)),
      [],
    );
  });

  it('only src/core/verify/ runs configured checks', () => {
    const hits = sources(SRC).filter(
      (file) =>
        /\brunCheck\b|verify\/run\.js/.test(readFileSync(file, 'utf8')) &&
        !relative(SRC, file).startsWith('core/verify/'),
    );
    assert.deepEqual(
      hits.map((file) => relative(SRC, file)),
      [],
    );
  });
});
