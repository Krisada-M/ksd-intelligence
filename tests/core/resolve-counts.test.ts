import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import ts from 'typescript';
import { Resolver, type FileResolution } from '../../src/core/indexing/resolve.js';

async function resolve(source: string, names: string[]): Promise<FileResolution> {
  const root = await mkdtemp(join(tmpdir(), 'ei-resolve-'));
  try {
    const file = join(root, 'uses.ts');
    await writeFile(file, source);
    const program = ts.createProgram([file], { noEmit: true, strict: true });
    const sf = program.getSourceFile(file);
    assert.ok(sf);
    return new Resolver(ts, program, {
      root,
      indexable: new Set(['uses.ts']),
      declarationNames: new Set(names),
      workspacePackages: new Set(),
    }).resolveFile(sf);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('counts every use target by category, whatever its name (ADR 0003)', async () => {
  const report = await resolve(
    'export const result = Math.floor(missingInput);\n' +
      'export function run(local: number) { return result + local; }\n',
    ['result', 'run'],
  );
  assert.deepEqual(report.counts, {
    indexed: 1,
    local: 1,
    external: 2,
    externalUnresolved: 0,
    unresolvedOther: 1,
    outsideScope: 0,
  });
});

it('an object literal uses the properties of its contextual type: shorthand, and through a union', async () => {
  const report = await resolve(
    [
      'export interface Options { name: string; size?: number }', // 1
      'export interface Other { size: number }', // 2
      'export function take(options?: Options): void {}', // 3
      'export function either(value: Options | Other): void {}', // 4
      'export function caller(name: string, size: number): void {', // 5
      '  take({ name });', // 6
      '  take({ name: "x" });', // 7
      '  either({ size });', // 8
      '}',
    ].join('\n'),
    ['Options', 'Other', 'name', 'size', 'take', 'either', 'caller'],
  );
  const lines = (target: string): number[] =>
    report.edges
      .filter((edge) => edge.source === 'uses.ts#caller' && edge.target === `uses.ts#${target}`)
      .flatMap((edge) => edge.lines)
      .sort();
  assert.deepEqual(lines('Options.name'), [6, 7]);
  assert.deepEqual(lines('Options.size'), [8]);
  assert.deepEqual(lines('Other.size'), [8]);
});

it('counts a declaration once when union instantiations share the same property', async () => {
  const report = await resolve(
    'export interface Box<T> { data: T }\n' +
      'export function use(box: Box<string> | Box<number>) { return box.data; }\n',
    ['Box', 'data', 'use'],
  );
  assert.equal(report.counts.indexed, 3, 'two Box type uses and one shared data property');
  assert.equal(report.counts.local, 2, 'the type parameter and the local box use');
});

it('a literal that names a property is a use of it: T["k"], and quoted or numeric keys typed by context', async () => {
  const report = await resolve(
    [
      'export interface Options { name: string; 11: number }', // 1
      'export function take(options: Options): void {}', // 2
      'export type Name = Options["name"];', // 3
      'export function caller(): void {', // 4
      '  take({ "name": "x", 11: 1 });', // 5
      '}',
    ].join('\n'),
    ['Options', 'name', 'take', 'caller', 'Name'],
  );
  const lines = (source: string, target: string): number[] =>
    report.edges
      .filter((edge) => edge.source === `uses.ts#${source}` && edge.target === `uses.ts#${target}`)
      .flatMap((edge) => edge.lines)
      .sort();
  assert.deepEqual(lines('Name', 'Options.name'), [3]);
  assert.deepEqual(lines('caller', 'Options.name'), [5]);
  assert.deepEqual(lines('caller', 'Options.11'), [5]);
});
