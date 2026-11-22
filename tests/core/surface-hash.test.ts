import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { fileDeclarations } from '../../src/core/indexing/declarations.js';
import {
  declarationSurfaces,
  surfaceOf,
  type DeclarationSurfacesResult,
  type Surface,
} from '../../src/core/indexing/surface.js';

function surface(source: string, file = 'a.ts'): Surface {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return surfaceOf(ts, sf, fileDeclarations(ts, sf, file));
}

function declSurfaces(source: string, file = 'a.ts'): DeclarationSurfacesResult {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return declarationSurfaces(ts, sf, fileDeclarations(ts, sf, file));
}

const same = (a: string, b: string, file = 'a.ts'): void =>
  assert.equal(surface(a, file).hash, surface(b, file).hash);
const different = (a: string, b: string, file = 'a.ts'): void =>
  assert.notEqual(surface(a, file).hash, surface(b, file).hash);

describe('export-surface hash: syntax only, no checker (DESIGN §6.2.1)', () => {
  it('a body edit behind a written signature is not a surface change', () => {
    same(
      'export function f(a: number): string {\n  return String(a);\n}\n',
      'export function f(a: number): string {\n  return `${a}!`;\n}\n',
    );
    same(
      'export const g = (a: number): number => a + 1;\n',
      'export const g = (a: number): number => a + 2;\n',
    );
    same(
      'export const v: number = Math.floor(1.5);\n',
      'export const v: number = Math.ceil(1.5);\n',
    );
  });

  it('a signature edit is a surface change', () => {
    different(
      'export function f(a: number): string {\n  return "";\n}\n',
      'export function f(a: number, b?: number): string {\n  return "";\n}\n',
    );
    different(
      'export function f(a: number): string {\n  return "";\n}\n',
      'export function f(a: number): number {\n  return 0;\n}\n',
    );
    different('export const v: number = 1;\n', 'export const v: string = "";\n');
  });

  it('an inferred type includes the body or initializer', () => {
    const before = 'export function f() {\n  return 1;\n}\n';
    const after = 'export function f() {\n  return "a";\n}\n';
    different(before, after);
    different('export const c = 1;\n', 'export const c = 2;\n');
    different('export const k = () => 1;\n', 'export const k = () => "1";\n');
    different('export function f(a = 1): void {}\n', 'export function f(a = "x"): void {}\n');
  });

  it('`const` and `let` infer different literal types', () => {
    different('export const c = 1;\n', 'export let c = 1;\n');
  });

  it('a private helper counts only when an observable declaration names it', () => {
    const helper = (body: string): string =>
      `function help() {\n  return ${body};\n}\nexport const used = help();\n`;
    different(helper('1'), helper('"a"'));
    same(
      'function help() {\n  return 1;\n}\nexport const kept: number = 1;\n',
      'function help() {\n  return "a";\n}\nexport const kept: number = 1;\n',
    );
    // The name closure is transitive: used -> a -> b.
    const chain = (body: string): string =>
      `function b() {\n  return ${body};\n}\nfunction a() {\n  return b();\n}\nexport const used = a();\n`;
    different(chain('1'), chain('"a"'));
    // Observable keys feed update propagation: written or inferred, exported or named.
    const keys = (source: string): string[] => [...surface(source).observableKeys].sort();
    assert.deepEqual(keys(chain('1')), ['a.ts#a', 'a.ts#b', 'a.ts#used']);
    assert.deepEqual(
      keys('function help() {}\nexport function kept(): number {\n  return 1;\n}\n'),
      ['a.ts#kept'],
    );
  });

  it('class members: a written member signature hides its body, an inferred one does not', () => {
    same(
      'export class K {\n  run(): number {\n    return 1;\n  }\n}\n',
      'export class K {\n  run(): number {\n    return 2;\n  }\n}\n',
    );
    different(
      'export class K {\n  run() {\n    return 1;\n  }\n}\n',
      'export class K {\n  run() {\n    return "1";\n  }\n}\n',
    );
    different('export class K {\n  x = 1;\n}\n', 'export class K {\n  x = "1";\n}\n');
    different('export class K extends A {\n}\n', 'export class K extends B {\n}\n');
  });

  it('members of an annotated object literal stay hidden; an unannotated one is hashed whole', () => {
    same(
      'export const api: Api = {\n  run() {\n    return 1;\n  },\n};\n',
      'export const api: Api = {\n  run() {\n    return 2;\n  },\n};\n',
    );
    different(
      'export const api = {\n  run() {\n    return 1;\n  },\n};\n',
      'export const api = {\n  run() {\n    return 2;\n  },\n};\n',
    );
  });

  it('a destructured name takes the type of its declaration', () => {
    different('export const { a } = make(1);\n', 'export const { a } = make(2);\n');
  });

  it('export forms, ambient modules and imports that inferred types name', () => {
    different("export { a } from './x';\n", "export { a } from './y';\n");
    different("export * from './x';\n", "export * from './y';\n");
    different('export default 1;\n', 'export default 2;\n');
    different(
      "declare module 'x' {\n  export const a: number;\n}\n",
      "declare module 'x' {\n  export const a: string;\n}\n",
    );
    const imported = (from: string): string =>
      `import { make } from '${from}';\nexport const value = make();\n`;
    different(imported('./b'), imported('./c'));
    same(
      "import { unused } from './b';\nexport const v: number = 1;\n",
      "import { unused } from './c';\nexport const v: number = 1;\n",
    );
  });

  it('unexported and unnamed declarations do not change the surface', () => {
    same(
      'function hidden() {\n  return 1;\n}\nexport const v: number = 1;\n',
      'function hidden() {\n  return 2;\n}\nexport const v: number = 1;\n',
    );
  });

  it('JavaScript has no written types: the whole declaration counts', () => {
    different(
      'export function f(a) {\n  return a;\n}\n',
      'export function f(a) {\n  return a + 1;\n}\n',
      'a.js',
    );
    different(
      '/** @returns {number} */\nexport function f() {\n  return 1;\n}\n',
      '/** @returns {string} */\nexport function f() {\n  return 1;\n}\n',
      'a.js',
    );
  });

  it('formatting and comments outside a declaration are not a change', () => {
    same(
      'export function f(a: number): string {\n  return "";\n}\n',
      '// note\nexport function f(a: number): string {\n  return "";\n}\n// tail\n',
    );
  });

  it('is a pure function of the text: the same text hashes the same', () => {
    const text =
      'export function f(a: number) {\n  return a;\n}\nexport interface I { x: number }\n';
    assert.deepEqual(surface(text), surface(text));
    assert.match(surface(text).hash, /^[0-9a-f]{32}$/);
  });
});

describe('declarationSurfaces: per-declaration diff semantics for ei_changes', () => {
  it('distinguishes body-only edits (modified) from signature/inferred-return edits (signature-changed)', () => {
    const writtenBefore = declSurfaces(
      'export function f(a: number): number {\n  return a + 1;\n}\n',
    );
    const writtenBodyEdit = declSurfaces(
      'export function f(a: number): number {\n  return a + 2;\n}\n',
    );
    assert.equal(
      writtenBefore.declarations.get('a.ts#f')?.surfaceHash,
      writtenBodyEdit.declarations.get('a.ts#f')?.surfaceHash,
    );
    assert.notEqual(
      writtenBefore.declarations.get('a.ts#f')?.bodyHash,
      writtenBodyEdit.declarations.get('a.ts#f')?.bodyHash,
    );

    // Inferred return type: surface.ts includes the body, so body edits change surfaceHash.
    const inferredBefore = declSurfaces('export function g(a: number) {\n  return a + 1;\n}\n');
    const inferredBodyEdit = declSurfaces('export function g(a: number) {\n  return a + 2;\n}\n');
    assert.notEqual(
      inferredBefore.declarations.get('a.ts#g')?.surfaceHash,
      inferredBodyEdit.declarations.get('a.ts#g')?.surfaceHash,
    );
  });

  it('whitespace-only and comment-only edits keep fileTokenHash identical on TS, while JS preserves JSDoc', () => {
    const a = declSurfaces('export function f(a: number): number {\n  return a + 1;\n}\n');
    const b = declSurfaces(
      '// header comment\nexport function f(\n  a: number /* inline */\n): number {\n  return a + 1;\n}\n',
    );
    assert.equal(a.fileTokenHash, b.fileTokenHash);
    assert.equal(a.moduleHash, b.moduleHash);

    const jsBefore = declSurfaces(
      '/** @returns {number} */\nexport function f() {\n  return 1;\n}\n',
      'a.js',
    );
    const jsDocEdit = declSurfaces(
      '/** @returns {string} */\nexport function f() {\n  return 1;\n}\n',
      'a.js',
    );
    const jsCommentOnly = declSurfaces(
      '// plain comment\n/** @returns {number} */\nexport function f() {  return 1; }\n',
      'a.js',
    );
    assert.notEqual(jsBefore.fileTokenHash, jsDocEdit.fileTokenHash);
    assert.notEqual(
      jsBefore.declarations.get('a.js#f')?.surfaceHash,
      jsDocEdit.declarations.get('a.js#f')?.surfaceHash,
    );
    assert.equal(jsBefore.fileTokenHash, jsCommentOnly.fileTokenHash);
  });

  it('isolates container class from its indexed members and detects export bit on const', () => {
    const clsBefore = declSurfaces(
      'export class Svc {\n  charge(x: number): number { return x; }\n}\n',
    );
    const clsMethodEdit = declSurfaces(
      'export class Svc {\n  charge(x: number): number { return x * 2; }\n}\n',
    );
    assert.equal(
      clsBefore.declarations.get('a.ts#Svc')?.surfaceHash,
      clsMethodEdit.declarations.get('a.ts#Svc')?.surfaceHash,
    );
    assert.equal(
      clsBefore.declarations.get('a.ts#Svc')?.bodyHash,
      clsMethodEdit.declarations.get('a.ts#Svc')?.bodyHash,
    );
    assert.notEqual(
      clsBefore.declarations.get('a.ts#Svc.charge')?.bodyHash,
      clsMethodEdit.declarations.get('a.ts#Svc.charge')?.bodyHash,
    );

    const privateConst = declSurfaces('const x: number = 1;\n');
    const exportedConst = declSurfaces('export const x: number = 1;\n');
    assert.notEqual(
      privateConst.declarations.get('a.ts#x')?.surfaceHash,
      exportedConst.declarations.get('a.ts#x')?.surfaceHash,
    );
  });

  it('tracks top-level/import edits in moduleHash and deduplicates CJS aliases', () => {
    const modA = declSurfaces("import { a } from './x';\nexport function f(): void {}\n");
    const modB = declSurfaces(
      "import { a } from './x';\nimport { b } from './y';\nexport function f(): void {}\n",
    );
    assert.notEqual(modA.moduleHash, modB.moduleHash);
    assert.equal(
      modA.declarations.get('a.ts#f')?.surfaceHash,
      modB.declarations.get('a.ts#f')?.surfaceHash,
    );

    const cjsA = declSurfaces('exports.run = function (a) { return a; };\n', 'a.cjs');
    const cjsB = declSurfaces('exports.run = function (a) { return a + 1; };\n', 'a.cjs');
    assert.equal(cjsA.declarations.has('a.cjs#run'), true);
    assert.notEqual(
      cjsA.declarations.get('a.cjs#run')?.surfaceHash,
      cjsB.declarations.get('a.cjs#run')?.surfaceHash,
    );
  });
});
