function isIndexType(ts, type) {
    return (type.flags & ts.TypeFlags.Index) !== 0;
}
function isType(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'flags' in value &&
        typeof value.flags === 'number' &&
        'checker' in value);
}
function isTypeReference(ts, type) {
    return ('objectFlags' in type &&
        typeof type.objectFlags === 'number' &&
        (type.objectFlags & ts.ObjectFlags.Reference) !== 0);
}
/**
 * The `keyof X` a resolved key union was built from. `origin` is internal to TypeScript (kept
 * since 4.2 for display); the pinned compiler and the key tests catch a change of it.
 */
function unionOrigin(type) {
    if (!type.isUnion() || !('origin' in type))
        return undefined;
    const origin = type.origin;
    return isType(origin) ? origin : undefined;
}
/**
 * Key access through `keyof` (D52): a string literal used as a key of a type with declared
 * properties, and a non-literal key expression typed by `keyof T`. Owners come from written
 * types (`keyof X`, a type parameter constrained to one, a type alias of one) or from a key type
 * TypeScript built from `keyof X`; an ordinary `string` never yields an owner.
 */
export class KeyAccess {
    ts;
    checker;
    scope;
    constructor(ts, checker, scope) {
        this.ts = ts;
        this.checker = checker;
        this.scope = scope;
    }
    /** A string literal in a key position, or null when it names no indexed declaration. */
    literal(node) {
        const targets = new Map();
        const holders = new Set();
        let unindexed = false;
        for (const owner of this.ownersOfLiteral(node)) {
            const apparent = this.checker.getApparentType(owner);
            const property = this.checker.getPropertyOfType(apparent, node.text);
            if (property === undefined)
                continue;
            const keys = this.scope.indexedTargets(property);
            for (const key of keys)
                targets.set(key, property);
            // Mapped Record keys have no declaration at all; anonymous type members do, but their
            // declarations are outside ADR 0003. Only the latter need an owner-scoped gap.
            if (keys.length === 0) {
                if ((property.declarations?.length ?? 0) === 0)
                    continue;
                unindexed = true;
            }
            for (const key of this.ownerKeys(owner))
                holders.add(key);
        }
        const [single] = targets.values();
        if (!unindexed && targets.size === 1 && single !== undefined) {
            return { kind: 'property', property: single };
        }
        if (holders.size === 0)
            return null;
        return { kind: 'owners', owners: [...holders].sort() };
    }
    /** Owner keys of a non-literal key expression typed by `keyof T` (empty for any other type). */
    expression(node) {
        const keys = new Set();
        for (const owner of this.ownersOfExpression(node)) {
            for (const key of this.ownerKeys(owner))
                keys.add(key);
        }
        return [...keys].sort();
    }
    /** Whether a call passes `argument` to a parameter declared as a key (`keyof T`, `K`). */
    takesKey(call, argument) {
        const index = call.arguments?.indexOf(argument) ?? -1;
        const parameter = this.parameterAt(call, index);
        return parameter?.type !== undefined && this.writtenOwners(parameter.type).length > 0;
    }
    ownerKeys(owner) {
        const keys = [];
        for (const part of owner.isUnionOrIntersection() ? owner.types : [owner]) {
            const symbol = part.aliasSymbol ?? part.getSymbol();
            const declaration = symbol?.declarations?.[0];
            const key = declaration === undefined ? null : this.scope.ownerKey(declaration);
            if (key !== null)
                keys.push(key);
        }
        return keys;
    }
    ownersOfLiteral(node) {
        const ts = this.ts;
        let argument = node;
        let inArray = false;
        if (ts.isArrayLiteralExpression(node.parent)) {
            argument = node.parent;
            inArray = true;
        }
        const call = argument.parent;
        if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression !== argument) {
            // A generic call has already inferred `K` as the literal itself: read the declaration.
            const index = call.arguments?.indexOf(argument) ?? -1;
            const parameter = this.parameterAt(call, index);
            if (parameter?.type === undefined)
                return [];
            const rest = parameter.dotDotDotToken !== undefined;
            const declared = inArray || rest ? this.elementTypeNode(parameter.type) : parameter.type;
            if (declared === undefined || (inArray && rest))
                return [];
            return this.writtenOwners(declared).flatMap((owner) => this.instantiate(owner, call, parameter.parent));
        }
        const parent = node.parent;
        if ((ts.isVariableDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isParameter(parent)) &&
            parent.initializer === node &&
            parent.type !== undefined) {
            return this.concrete(this.writtenOwners(parent.type));
        }
        return this.concrete(this.ownersOfType(this.checker.getContextualType(node)));
    }
    ownersOfExpression(node) {
        const ts = this.ts;
        const name = ts.isPropertyAccessExpression(node) ? node.name : node;
        if (!ts.isIdentifier(name)) {
            return this.concrete(this.ownersOfType(this.checker.getTypeAtLocation(node)));
        }
        let symbol = this.checker.getSymbolAtLocation(name);
        if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            symbol = this.checker.getAliasedSymbol(symbol);
        }
        const declaration = symbol?.valueDeclaration;
        if (symbol === undefined || declaration === undefined)
            return [];
        const holdsValue = ts.isVariableDeclaration(declaration) ||
            ts.isParameter(declaration) ||
            ts.isPropertyDeclaration(declaration) ||
            ts.isPropertySignature(declaration) ||
            ts.isBindingElement(declaration);
        if (!holdsValue)
            return [];
        // A written type decides; only an inferred one asks the checker.
        if ('type' in declaration && declaration.type !== undefined) {
            return this.concrete(this.writtenOwners(declaration.type));
        }
        return this.concrete(this.ownersOfType(this.checker.getTypeOfSymbol(symbol)));
    }
    writtenOwners(node) {
        const type = this.checker.getTypeFromTypeNode(node);
        const constraint = this.checker.getBaseConstraintOfType(type) ?? type;
        // `keyof Usage | string` is just string: its syntax must not turn log("cost") into a read.
        if ((constraint.flags &
            (this.ts.TypeFlags.String | this.ts.TypeFlags.Any | this.ts.TypeFlags.Unknown)) !==
            0) {
            return [];
        }
        const targets = this.keyofTargets(node);
        // Resolving the type preserves instantiated generic aliases such as `Keys<Usage>`.
        return targets.length > 0
            ? targets.map((target) => this.checker.getTypeFromTypeNode(target))
            : this.ownersOfType(type);
    }
    /** Owners of a key type: `keyof X`, a key union built from one, or a constrained `K`. */
    ownersOfType(type, depth = 0) {
        if (type === undefined || depth > 3)
            return [];
        if (isIndexType(this.ts, type))
            return [type.type];
        const origin = unionOrigin(type);
        if (origin !== undefined && isIndexType(this.ts, origin))
            return [origin.type];
        if ((type.flags & this.ts.TypeFlags.TypeParameter) !== 0) {
            return this.ownersOfType(type.getConstraint(), depth + 1);
        }
        return [];
    }
    /** The `X` of every `keyof X` a written key type names, through `K extends …` and aliases. */
    keyofTargets(node, seen = new Set()) {
        const ts = this.ts;
        if (seen.has(node))
            return [];
        seen.add(node);
        if (ts.isParenthesizedTypeNode(node))
            return this.keyofTargets(node.type, seen);
        if (ts.isUnionTypeNode(node))
            return node.types.flatMap((t) => this.keyofTargets(t, seen));
        if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword) {
            return [node.type];
        }
        if (!ts.isTypeReferenceNode(node))
            return [];
        let symbol = this.checker.getSymbolAtLocation(node.typeName);
        if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            symbol = this.checker.getAliasedSymbol(symbol);
        }
        const declaration = symbol?.declarations?.[0];
        if (declaration === undefined)
            return [];
        if (ts.isTypeParameterDeclaration(declaration) && declaration.constraint !== undefined) {
            return this.keyofTargets(declaration.constraint, seen);
        }
        if (ts.isTypeAliasDeclaration(declaration) && declaration.typeParameters === undefined) {
            return this.keyofTargets(declaration.type, seen);
        }
        return [];
    }
    elementTypeNode(node) {
        const ts = this.ts;
        if (ts.isArrayTypeNode(node))
            return node.elementType;
        if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
            return this.elementTypeNode(node.type);
        }
        if (ts.isTypeReferenceNode(node) &&
            ts.isIdentifier(node.typeName) &&
            (node.typeName.text === 'Array' || node.typeName.text === 'ReadonlyArray')) {
            return node.typeArguments?.[0];
        }
        return undefined;
    }
    parameterAt(call, index) {
        if (index < 0)
            return undefined;
        // An untyped or unresolved call has no declaration (TypeScript returns a synthetic signature).
        const declaration = this.checker
            .getResolvedSignature(call)
            ?.getDeclaration();
        const parameters = declaration?.parameters ?? [];
        const last = parameters[parameters.length - 1];
        if (index < parameters.length)
            return parameters[index];
        return last?.dotDotDotToken !== undefined ? last : undefined;
    }
    /** A type parameter owner, instantiated at this call where the call shows it. */
    instantiate(type, call, signature) {
        const ts = this.ts;
        if ((type.flags & ts.TypeFlags.TypeParameter) === 0)
            return [type];
        // Inferred from an argument declared with exactly this type parameter: `get(o: T, k: K)`.
        if (ts.isFunctionLike(signature)) {
            for (const [index, parameter] of signature.parameters.entries()) {
                const argument = call.arguments?.[index];
                if (parameter.type === undefined || argument === undefined)
                    continue;
                if (this.checker.getTypeFromTypeNode(parameter.type) === type) {
                    return [this.checker.getTypeAtLocation(argument)];
                }
            }
        }
        // A type parameter of the receiver's class or interface: `store.get('k')` on `Store<Usage>`.
        const declaration = type.getSymbol()?.declarations?.[0];
        const holder = declaration?.parent;
        const callee = call.expression;
        if (declaration !== undefined &&
            ts.isTypeParameterDeclaration(declaration) &&
            holder !== undefined &&
            (ts.isClassLike(holder) || ts.isInterfaceDeclaration(holder)) &&
            (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
            const receiver = this.checker.getTypeAtLocation(callee.expression);
            const index = holder.typeParameters?.indexOf(declaration) ?? -1;
            if (isTypeReference(ts, receiver) && index >= 0) {
                const holderSymbol = holder.name === undefined ? undefined : this.checker.getSymbolAtLocation(holder.name);
                const argument = this.checker.getTypeArguments(receiver)[index];
                if (receiver.target.getSymbol() === holderSymbol && argument !== undefined) {
                    return [argument];
                }
            }
        }
        return this.concrete([type]);
    }
    /** Owners with type parameters replaced by their constraints; unconstrained ones dropped. */
    concrete(owners) {
        const ts = this.ts;
        return owners.flatMap((owner) => {
            if ((owner.flags & ts.TypeFlags.TypeParameter) === 0)
                return [owner];
            const constraint = owner.getConstraint();
            return constraint === undefined || (constraint.flags & ts.TypeFlags.TypeParameter) !== 0
                ? []
                : [constraint];
        });
    }
}
