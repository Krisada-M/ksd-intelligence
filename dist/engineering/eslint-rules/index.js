// Optional ESLint flat-config rules. ESLint supplies the AST, so OMP needs no parser dependency.
// Enable in each repository deliberately; this module is not auto-run by the OMP extension.

// A return after a single statement may hug it (`const x = f();` then `return x;`); from two statements on it needs air.
const MIN_PRECEDING_FOR_BLANK = 2;

function getTextAndGap(context, previous, next) {
  const source = context.sourceCode ?? context.getSourceCode();
  const begin = previous.loc.end.line;
  const end = next.loc.start.line;
  const between = source.lines.slice(begin, Math.max(begin, end - 1));
  const blankCount = between.filter(line => line.trim() === "").length;
  const containsOtherContent = between.some(line => line.trim() !== "");

  return { blankCount, containsOtherContent };
}

function adjacentImplementations(body) {
  return Array.isArray(body) ? body.filter(Boolean) : [];
}

function isFunction(node) {
  if (node?.type === "ExportNamedDeclaration" || node?.type === "ExportDefaultDeclaration") {
    return isFunction(node.declaration);
  }
  if (node?.type === "FunctionDeclaration") return Boolean(node.body); // excludes TS overload signatures
  if (node?.type !== "VariableDeclaration") return false;

  return node.declarations?.length === 1 &&
    ["ArrowFunctionExpression", "FunctionExpression"].includes(node.declarations[0]?.init?.type);
}

export const rules = {
  "blank-before-return": {
    meta: {
      type: "layout",
      docs: { description: "One empty line before a return preceded by two or more statements; never more than one" },
      schema: [],
      messages: { missing: "Leave exactly one blank line before this return.", extra: "Leave only one blank line before this return." },
    },
    create(context) {
      return {
        ReturnStatement(node) {
          const siblings = node.parent?.body;
          if (!Array.isArray(siblings)) return;
          const index = siblings.indexOf(node);
          if (index <= 0) return;
          const { blankCount, containsOtherContent } = getTextAndGap(context, siblings[index - 1], node);
          if (containsOtherContent) return; // comments/preprocessor matter; avoid false positives
          if (blankCount > 1) {
            context.report({ node, messageId: "extra" });

            return;
          }
          if (blankCount === 0 && index >= MIN_PRECEDING_FOR_BLANK) context.report({ node, messageId: "missing" });
        },
      };
    },
  },
  "blank-between-functions": {
    meta: {
      type: "layout",
      docs: { description: "Exactly one blank line between adjacent function implementations" },
      schema: [],
      messages: { missing: "Leave exactly one blank line between function implementations.", extra: "Leave only one blank line between function implementations." },
    },
    create(context) {
      function inspect(body) {
        const statements = adjacentImplementations(body);
        for (let i = 1; i < statements.length; i++) {
          const before = statements[i - 1];
          const after = statements[i];
          if (!isFunction(before) || !isFunction(after)) continue;
          const { blankCount, containsOtherContent } = getTextAndGap(context, before, after);
          if (containsOtherContent) continue;
          if (blankCount !== 1) context.report({ node: after, messageId: blankCount === 0 ? "missing" : "extra" });
        }
      }

      return {
        Program(node) { inspect(node.body); },
        BlockStatement(node) { inspect(node.body); },
      };
    },
  },
  "prefer-guard-clauses": {
    meta: {
      type: "suggestion",
      docs: { description: "Warn on avoidable directly nested if blocks; no unsafe auto-fix" },
      schema: [],
      messages: { nested: "Consider a guard clause instead of a nested if, if behavior remains equivalent." },
    },
    create(context) {
      return {
        IfStatement(node) {
          if (node.alternate) return;
          const only = node.consequent?.type === "BlockStatement" ? node.consequent.body : [];
          if (only.length === 1 && only[0]?.type === "IfStatement") {
            context.report({ node: only[0], messageId: "nested" });
          }
        },
      };
    },
  },
};

export default { rules };
