import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { rules } from "../../src/policy/eslint-rules/index.js";

const linter = new Linter();
const pluginName = "engineering-proxy";
const styleRules = {
  [`${pluginName}/blank-before-return`]: "error",
  [`${pluginName}/blank-between-functions`]: "error",
  [`${pluginName}/prefer-guard-clauses`]: "warn",
};

function config(fileName) {
  return [{
    files: [`**/${fileName ?? "*.js"}`],
    plugins: { [pluginName]: { rules } },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: styleRules,
  }];
}

function lint(code, fileName) {
  return linter.verify(code, config(fileName), fileName ?? "fixture.js");
}

function messagesOf(results, ruleOrWarn) {
  return results
    .filter(m => ruleOrWarn ? m.messageId === ruleOrWarn : true)
    .map(m => `${m.ruleId}:${m.messageId}`);
}

test("RuleTester-equivalent: declarations, exports and arrows all report missing separators", () => {
  const code = [
    "function alpha() {",
    "  return 1;",
    "}",
    "function beta() {",
    "  return 2;",
    "}",
    "export function gamma() {",
    "  return 3;",
    "}",
    "const delta = () => 4;",
    "const eps = () => 5;",
  ].join("\n");
  const messages = messagesOf(lint(code), "missing");
  // alpha|beta, beta|gamma, gamma|delta, delta|eps = 4 blank-between-functions + none from arrows' insides
  assert.equal(messages.filter(m => m.startsWith(`${pluginName}/blank-between-functions`)).length, 4);
});

test("TS overload groups stay untouched and full members still need exactly one blank", () => {
  const code = [
    "export function sized(target: string): string;",
    "export function sized(target: number): number;",
    "export function sized(target: string | number): string | number {",
    "  return target;",
    "}",
  ].join("\n");
  const messages = messagesOf(lint(code, "fixture.ts"));
  assert.deepEqual(messages, []);
  assert.equal(lint(code, "fixture.ts").every(m => m.fatal !== true), true);
});

test("first-statement guard return has no leading blank; later returns need exactly one", () => {
  const clean = [
    "function pick(minus) {",
    "  if (minus < 0) return null;",
    "  if (minus === 0) return null;",
    "",
    "  return { value: minus };",
    "}",
    "",
    "function after() {",
    "  return minus(1);",
    "  function minus(x) { return x; }",
    "}",
  ].join("\n");
  assert.deepEqual(messagesOf(lint(clean)), []);
});

test("return after one statement may hug it; after two or more it needs exactly one blank", () => {
  const returnRule = `${pluginName}/blank-before-return`;
  const ofRule = code => lint(code).filter(m => m.ruleId === returnRule).map(m => m.messageId);

  assert.deepEqual(ofRule("function a(x) {\n  const y = x + 1;\n  return y;\n}"), []);
  assert.deepEqual(ofRule("function a(x) {\n  const y = x + 1;\n\n  return y;\n}"), []);
  assert.deepEqual(ofRule("function a(x) {\n  const y = x + 1;\n\n\n  return y;\n}"), ["extra"]);
  assert.deepEqual(ofRule("function a(x) {\n  const y = x + 1;\n  const z = y * 2;\n  return z;\n}"), ["missing"]);
  assert.deepEqual(ofRule("function a(x) {\n  const y = x + 1;\n  const z = y * 2;\n\n  return z;\n}"), []);
});

test("exactly-one blank enforced: zero and two are both errors, comments block false positives", () => {
  const zero = "function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}";
  const two = "function a() {\n  return 1;\n}\n\n\nfunction b() {\n  return 1;\n}";
  assert.equal(messagesOf(lint(zero), "missing").length, 1);
  assert.equal(messagesOf(lint(two), "extra").length, 1);

  const commented = "function a() {\n  return 1;\n}\n// linking comment\nfunction b() {\n  return 1;\n}";
  assert.deepEqual(messagesOf(lint(commented)), [], "comments between functions are respected, not spacing errors");
});

test("prefer-guard-clauses is warning-only with no autofix, and deep nesting stays single-message", () => {
  const code = [
    "function shallow(list) {",
    "  if (list) {",
    "    if (list.length > 0) {",
    "      return list;",
    "    }",
    "  }",
    "  return [];",
    "}",
  ].join("\n");
  const messages = lint(code);
  const nested = messages.filter(m => m.ruleId === `${pluginName}/prefer-guard-clauses`);
  assert.equal(nested.length, 1);
  assert.equal(rules["prefer-guard-clauses"].meta.fixable, undefined, "no unsafe semantic autofix");
});

test("style rules leave unrelated spacing and TS overloads alone end-to-end", () => {
  const code = [
    "type Priced = { vip: boolean; subtotal: number };",
    "",
    "export function price(input: number): number;",
    "export function price(input: string): string;",
    "export function price(input: number | string): number | string {",
    "  const raw = typeof input === 'string' ? Number(input) : input;",
    "  if (raw < 0) {",
    "    return 0;",
    "  }",
    "",
    "  return raw;",
    "}",
  ].join("\n");
  assert.deepEqual(messagesOf(lint(code, "fixture.ts")), []);
});
