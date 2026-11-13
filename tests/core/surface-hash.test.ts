import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { fileDeclarations } from '../../src/core/indexing/declarations.js';
import { surfaceOf, type Surface } from '../../src/core/indexing/surface.js';

function surface(source: string, file = 'a.ts'): Surface {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return surfaceOf(ts, sf, fileDeclarations(ts, sf, file));
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

  it('an inferred type includes the body or initializer, and says so', () => {
    const before = 'export function f() {\n  return 1;\n}\n';
    const after = 'export function f() {\n  return "a";\n}\n';
    different(before, after);
    assert.deepEqual([...surface(before).inferredKeys], ['a.ts#f']);
    different('export const c = 1;\n', 'export const c = 2;\n');
    different('export const k = () => 1;\n', 'export const k = () => "1";\n');
    different('export function f(a = 1): void {}\n', 'export function f(a = "x"): void {}\n');
    assert.deepEqual([...surface('export function f(a: number): void {}\n').inferredKeys], []);
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
