import { createHash } from 'node:crypto';
export const MODULE_NAME = '<module>';
// Pairs TypeScript itself merges into one symbol (ADR 0002: overloads and merged declarations).
const MERGEABLE = new Set([
    'function+function',
    'method+method',
    'accessor+accessor',
    'interface+interface',
    'class+interface',
    'interface+class',
    'namespace+namespace',
    'namespace+function',
    'function+namespace',
    'namespace+class',
    'class+namespace',
    'namespace+enum',
    'enum+namespace',
    'enum+enum',
    'var+var',
]);
const MAX_OBJECT_DEPTH = 3;
function lineOf(sf, pos) {
    return sf.getLineAndCharacterOfPosition(pos).line + 1;
}
export function spanOf(ts, sf, node) {
    return [lineOf(sf, node.getStart(sf)), lineOf(sf, node.getEnd())];
}
/** The text of a member or property name, or null for a computed name that is not a literal. */
function nameText(ts, name) {
    if (name === undefined)
        return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))
        return name.text;
    if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
        return name.text;
    if (ts.isComputedPropertyName(name)) {
        const expr = name.expression;
        if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr))
            return expr.text;
    }
    return null;
}
function hasModifier(ts, node, kind) {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}
function unwrap(ts, expr) {
    let current = expr;
    while (ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current)) {
        current = current.expression;
    }
    return current;
}
/** `exports.x`, `module.exports.x` → `x`; `module.exports` → ''; anything else → null. */
function cjsExportName(ts, target) {
    if (!ts.isPropertyAccessExpression(target))
        return null;
    const object = target.expression;
    if (ts.isIdentifier(object) && object.text === 'exports')
        return target.name.text;
    if (ts.isIdentifier(object) && object.text === 'module' && target.name.text === 'exports') {
        return '';
    }
    const viaModuleExports = ts.isPropertyAccessExpression(object) &&
        ts.isIdentifier(object.expression) &&
        object.expression.text === 'module' &&
        object.name.text === 'exports';
    return viaModuleExports ? target.name.text : null;
}
function isFunctionValue(ts, expr) {
    return expr !== undefined && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr));
}
/** Signature text without bodies: what callers depend on syntactically. */
function signatureText(ts, sf, node) {
    const text = sf.text;
    const start = node.getStart(sf);
    if (ts.isClassDeclaration(node))
        return text.slice(start, node.members.pos);
    if (ts.isModuleDeclaration(node))
        return text.slice(start, node.name.getEnd());
    if (ts.isFunctionLike(node) && 'body' in node && node.body !== undefined) {
        return text.slice(start, node.body.getStart(sf));
    }
    let value;
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
        value = node.initializer && unwrap(ts, node.initializer);
    }
    else if (ts.isBinaryExpression(node)) {
        value = unwrap(ts, node.right);
    }
    if (isFunctionValue(ts, value))
        return text.slice(start, value.body.getStart(sf));
    if (value !== undefined && ts.isObjectLiteralExpression(value)) {
        return text.slice(start, value.getStart(sf));
    }
    return text.slice(start, node.getEnd());
}
function variableKind(ts, init) {
    if (isFunctionValue(ts, init))
        return 'function';
    if (init !== undefined && ts.isClassExpression(init))
        return 'class';
    return 'variable';
}
function mergeKindOf(ts, node) {
    if (ts.isFunctionDeclaration(node))
        return 'function';
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
        return 'method';
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        return 'accessor';
    }
    if (ts.isInterfaceDeclaration(node))
        return 'interface';
    if (ts.isClassDeclaration(node))
        return 'class';
    if (ts.isModuleDeclaration(node))
        return 'namespace';
    if (ts.isEnumDeclaration(node))
        return 'enum';
    if (ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
        return 'var';
    }
    return 'other';
}
/**
 * The indexed declarations of one file with their stable keys (ADR 0002, ADR 0003). Pure: depends
 * on the file's syntax tree only, so the extract-local cache can key it by content hash.
 */
export function fileDeclarations(ts, sf, file) {
    const entries = [];
    const exportedNames = new Set();
    const add = (name, kind, node, exported, aliases = []) => {
        const hasBody = 'body' in node && node.body !== undefined;
        entries.push({ name, kind, merge: mergeKindOf(ts, node), node, aliases, exported, hasBody });
    };
    const objectMembers = (literal, owner, depth, exported) => {
        for (const property of literal.properties) {
            const name = nameText(ts, property.name);
            if (name === null)
                continue;
            const qualified = `${owner}.${name}`;
            if (ts.isPropertyAssignment(property)) {
                const init = unwrap(ts, property.initializer);
                add(qualified, isFunctionValue(ts, init) ? 'method' : 'property', property, exported);
                if (ts.isObjectLiteralExpression(init) && depth < MAX_OBJECT_DEPTH) {
                    objectMembers(init, qualified, depth + 1, exported);
                }
            }
            else if (ts.isShorthandPropertyAssignment(property)) {
                add(qualified, 'property', property, exported);
            }
            else if (ts.isMethodDeclaration(property)) {
                add(qualified, 'method', property, exported);
            }
            else if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
                add(qualified, 'accessor', property, exported);
            }
        }
    };
    const classMembers = (members, owner, exported) => {
        const instanceNames = new Set();
        for (const member of members) {
            const name = nameText(ts, member.name);
            if (name !== null && !hasModifier(ts, member, ts.SyntaxKind.StaticKeyword)) {
                instanceNames.add(name);
            }
        }
        for (const member of members) {
            if (ts.isConstructorDeclaration(member)) {
                for (const parameter of member.parameters) {
                    const isProperty = ts.canHaveModifiers(parameter) &&
                        (ts.getModifiers(parameter) ?? []).some((m) => m.kind === ts.SyntaxKind.PublicKeyword ||
                            m.kind === ts.SyntaxKind.PrivateKeyword ||
                            m.kind === ts.SyntaxKind.ProtectedKeyword ||
                            m.kind === ts.SyntaxKind.ReadonlyKeyword);
                    if (isProperty && ts.isIdentifier(parameter.name)) {
                        add(`${owner}.${parameter.name.text}`, 'property', parameter, exported);
                    }
                }
                continue;
            }
            const name = nameText(ts, member.name);
            if (name === null)
                continue;
            const isStatic = hasModifier(ts, member, ts.SyntaxKind.StaticKeyword);
            const qualified = isStatic && instanceNames.has(name) ? `${owner}.static:${name}` : `${owner}.${name}`;
            if (ts.isMethodDeclaration(member))
                add(qualified, 'method', member, exported);
            else if (ts.isPropertyDeclaration(member))
                add(qualified, 'property', member, exported);
            else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
                add(qualified, 'accessor', member, exported);
            }
        }
    };
    const typeMembers = (members, owner, exported) => {
        for (const member of members) {
            const name = nameText(ts, member.name);
            if (name === null)
                continue;
            const qualified = `${owner}.${name}`;
            if (ts.isMethodSignature(member))
                add(qualified, 'method', member, exported);
            else if (ts.isPropertySignature(member))
                add(qualified, 'property', member, exported);
            else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
                add(qualified, 'accessor', member, exported);
            }
        }
    };
    const bindingNames = (name, prefix, exported) => {
        if (ts.isIdentifier(name))
            return;
        for (const element of name.elements) {
            if (ts.isOmittedExpression(element))
                continue;
            if (ts.isIdentifier(element.name))
                add(prefix + element.name.text, 'variable', element, exported);
            else
                bindingNames(element.name, prefix, exported);
        }
    };
    const statements = (list, prefix, inExported) => {
        for (const statement of list) {
            const exportModifier = hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword);
            const exported = prefix === '' ? exportModifier : inExported && exportModifier;
            const isDefault = hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword);
            if (ts.isFunctionDeclaration(statement)) {
                const name = statement.name?.text ?? (isDefault ? 'default' : null);
                if (name !== null)
                    add(prefix + name, 'function', statement, exported);
            }
            else if (ts.isClassDeclaration(statement)) {
                const name = statement.name?.text ?? (isDefault ? 'default' : null);
                if (name === null)
                    continue;
                add(prefix + name, 'class', statement, exported);
                classMembers(statement.members, prefix + name, exported);
            }
            else if (ts.isInterfaceDeclaration(statement)) {
                add(prefix + statement.name.text, 'interface', statement, exported);
                typeMembers(statement.members, prefix + statement.name.text, exported);
            }
            else if (ts.isTypeAliasDeclaration(statement)) {
                add(prefix + statement.name.text, 'type', statement, exported);
            }
            else if (ts.isEnumDeclaration(statement)) {
                const owner = prefix + statement.name.text;
                add(owner, 'enum', statement, exported);
                for (const member of statement.members) {
                    const name = nameText(ts, member.name);
                    if (name !== null)
                        add(`${owner}.${name}`, 'enum-member', member, exported);
                }
            }
            else if (ts.isModuleDeclaration(statement)) {
                moduleDeclaration(statement, prefix, exported);
            }
            else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    if (!ts.isIdentifier(declaration.name)) {
                        bindingNames(declaration.name, prefix, exported);
                        continue;
                    }
                    const name = prefix + declaration.name.text;
                    const init = declaration.initializer && unwrap(ts, declaration.initializer);
                    add(name, variableKind(ts, init), declaration, exported);
                    if (init !== undefined && ts.isObjectLiteralExpression(init)) {
                        objectMembers(init, name, 1, exported);
                    }
                    if (init !== undefined && ts.isClassExpression(init)) {
                        classMembers(init.members, name, exported);
                    }
                }
            }
            else if (ts.isExportAssignment(statement) && prefix === '') {
                const expr = unwrap(ts, statement.expression);
                if (ts.isIdentifier(expr))
                    exportedNames.add(expr.text);
                else
                    add('default', 'default', statement, true);
            }
            else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) {
                const clause = statement.exportClause;
                if (clause !== undefined && ts.isNamedExports(clause)) {
                    for (const element of clause.elements) {
                        exportedNames.add((element.propertyName ?? element.name).text);
                    }
                }
            }
            else if (ts.isExpressionStatement(statement) && prefix === '') {
                commonJs(statement.expression);
            }
        }
    };
    const commonJs = (expression) => {
        if (!ts.isBinaryExpression(expression))
            return;
        if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
            return;
        const name = cjsExportName(ts, expression.left);
        if (name === null)
            return;
        const value = unwrap(ts, expression.right);
        if (name !== '') {
            if (ts.isIdentifier(value) && value.text === name) {
                exportedNames.add(name);
                return;
            }
            add(name, variableKind(ts, value), expression, true, [expression.left]);
            if (ts.isObjectLiteralExpression(value))
                objectMembers(value, name, 1, true);
            return;
        }
        // module.exports = …
        if (ts.isIdentifier(value)) {
            exportedNames.add(value.text);
            return;
        }
        if (!ts.isObjectLiteralExpression(value)) {
            add('default', 'default', expression, true);
            return;
        }
        for (const property of value.properties) {
            const memberName = nameText(ts, property.name);
            if (memberName === null)
                continue;
            if (ts.isShorthandPropertyAssignment(property)) {
                exportedNames.add(memberName);
                continue;
            }
            if (ts.isPropertyAssignment(property)) {
                const init = unwrap(ts, property.initializer);
                if (ts.isIdentifier(init) && init.text === memberName) {
                    exportedNames.add(memberName);
                    continue;
                }
                add(memberName, variableKind(ts, init), property, true);
            }
            else if (ts.isMethodDeclaration(property)) {
                add(memberName, 'function', property, true);
            }
        }
    };
    const moduleDeclaration = (statement, prefix, exported) => {
        if (!ts.isIdentifier(statement.name)) {
            // `declare global { … }`: its declarations are this file's; `declare module "x"` is ambient.
            const isGlobal = (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
            if (isGlobal && statement.body !== undefined && ts.isModuleBlock(statement.body)) {
                statements(statement.body.statements, '', true);
            }
            return;
        }
        const name = prefix + statement.name.text;
        add(name, 'namespace', statement, exported);
        const body = statement.body;
        if (body === undefined)
            return;
        if (ts.isModuleBlock(body))
            statements(body.statements, `${name}.`, exported);
        else if (ts.isModuleDeclaration(body))
            moduleDeclaration(body, `${name}.`, exported);
    };
    statements(sf.statements, '', true);
    // Group same-name entries TypeScript merges; other repeats get `~2`, `~3` in source order.
    const groups = [];
    const byName = new Map();
    for (const entry of entries) {
        const existing = byName.get(entry.name) ?? [];
        const target = existing.find((group) => group.entries.every((other) => MERGEABLE.has(`${other.merge}+${entry.merge}`)));
        if (target !== undefined) {
            target.entries.push(entry);
            continue;
        }
        const suffixed = existing.length === 0 ? entry.name : `${entry.name}~${existing.length + 1}`;
        const group = { name: suffixed, entries: [entry] };
        existing.push(group);
        byName.set(entry.name, existing);
        groups.push(group);
    }
    const keyOf = new Map();
    const moduleKey = `${file}#${MODULE_NAME}`;
    const [, lastLine] = spanOf(ts, sf, sf);
    const declarations = [
        {
            key: moduleKey,
            file,
            name: MODULE_NAME,
            simple: MODULE_NAME,
            kind: 'module',
            exported: false,
            startLine: 1,
            endLine: Math.max(1, lastLine),
            otherSpans: [],
            sigHash: '',
        },
    ];
    for (const group of groups) {
        const key = `${file}#${group.name}`;
        // An overload set's span is its implementation; any other merge's span is its first declaration.
        const overloads = group.entries.every((e) => e.merge === 'function' || e.merge === 'method');
        const primary = (overloads ? group.entries.find((entry) => entry.hasBody) : undefined) ?? group.entries[0];
        if (primary === undefined)
            continue;
        const [startLine, endLine] = spanOf(ts, sf, primary.node);
        const otherSpans = group.entries
            .filter((entry) => entry !== primary)
            .map((entry) => spanOf(ts, sf, entry.node).join('-'));
        const signature = group.entries
            .map((entry) => signatureText(ts, sf, entry.node).replace(/\s+/g, ' ').trim())
            .join('\n');
        const segments = group.name.split('.');
        const last = segments[segments.length - 1] ?? group.name;
        declarations.push({
            key,
            file,
            name: group.name,
            simple: last.replace(/^static:/, '').replace(/~\d+$/, ''),
            kind: primary.kind,
            exported: group.entries.some((entry) => entry.exported) || exportedNames.has(group.name),
            startLine,
            endLine,
            otherSpans,
            sigHash: createHash('sha256')
                .update(`${primary.kind}\n${signature}`)
                .digest('hex')
                .slice(0, 16),
        });
        for (const entry of group.entries) {
            keyOf.set(entry.node, key);
            for (const alias of entry.aliases)
                keyOf.set(alias, key);
        }
    }
    return { declarations, keyOf, moduleKey };
}
/** The key of the nearest enclosing indexed declaration of a use site (ADR 0002). */
export function enclosingKey(node, declarations) {
    let current = node.parent;
    while (current !== undefined) {
        const key = declarations.keyOf.get(current);
        if (key !== undefined)
            return key;
        current = current.parent;
    }
    return declarations.moduleKey;
}
