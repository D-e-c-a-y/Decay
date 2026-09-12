class Compiler {
    constructor(logger) {
        this.logger = logger;
        this.functions = [];
        this.locals = [[]];
        this.upvalues = [[]];
        this.scopeDepth = 0;
        this.loopStack = [];
        this.switchStack = [];
        this.knownGlobals = new Set(["print", "len", "str", "type", "clock", "push", "pop", "assert"]);
        this.declaredFunctions = new Set();
        this.builtinCallNames = new Set([
            "print", "clock", "str", "num", "type", "len",
            "push", "pop", "max", "min", "abs", "floor", "ceil", "round",
            "sqrt", "pow", "has", "match", "sub", "slice",
            "split", "join", "trim", "upper", "lower",
            "push", "pop", "shift", "unshift", "contains",
            "keys", "values", "has", "remove", "merge",
            "json_parse", "json_str",
            "clone", "unique", "shuffle", "reverse",
            "clamp", "lerp", "sign",
            "b64_enc", "b64_dec",
            "set_base", "get_base",
            "dot_product", "vec_add", "vec_sub", "vec_scale", "vec_mag", "vec_norm", "vec_dist",
            "mat_mul", "vec_softmax"
        ]);
        this.inMethod = false;
        this.fnContext = [];
        this.currentLine = 1;
        this.debugStack = true;
        this.debugRangeTrace = (typeof window !== 'undefined' && window.DEBUG_RANGE_TRACE) ? true : false;
    }

    init() {
        const main = new ObjFunction("main");
        this.functions = [main];
        this.locals = [[]];
        this.upvalues = [[]];
        this.scopeDepth = 0;
        this.loopStack = [];
        this.switchStack = [];
        this.knownGlobals = new Set(["print", "len", "str", "type", "clock", "push", "pop", "assert"]);
        this.inMethod = false;
        this.fnContext = [];
        this.currentLine = 1;
        this.debugRangeTrace = (typeof window !== 'undefined' && window.DEBUG_RANGE_TRACE) ? true : false;
    }

    error(msg) {
    throw new Error(`[COMPILER ERROR] ${msg} at Line: ${this.currentLine}`);
}

    compile(ast, isModule = false) {
        this.init();
        this.isModule = isModule; // Save the flag
        const compileSnapshot = this.snapshotCompilerState();
        const root = Array.isArray(ast) ? ast : (ast.body || ast.statements || []);
        const hasEntryIn = Array.isArray(root) && root.some(n => {
            if (!n || n.type !== "FunctionDef" || n.isMethod) return false;
            if (n.entryFlagSignature) return true;
            const nName = this.getName(n.name);
            if (nName === "in") return true;
            if (n.name === "in") return true;
            if (n.name && n.name.value === "in") return true;
            return false;
        });
        if (this.logger) {
            this.logger(`[DEBUG][COMPILER] hasEntryIn=${hasEntryIn} knownGlobalsHasIn=${this.knownGlobals.has("in")} isModule=${!!isModule}`);
        }
        
        // Pre-scan: report initializer returns with values before bytecode emission.
        const initReturnIssues = this.findInitializerReturnViolations(root);
        for (const issue of initReturnIssues) {
            if (this.logger) this.logger(`[COMPILER:INIT-RETURN] class=${issue.className} method=${issue.methodName} return=${issue.returnType}`);
        }
        
        this.visitBlock(root, false); 
        
        
        if (!isModule) {
            const shouldInvokeEntry = this.knownGlobals.has("in") || hasEntryIn;
            if (this.logger) {
                this.logger(`[DEBUG][COMPILER] shouldInvokeEntry=${shouldInvokeEntry}`);
            }
            if (shouldInvokeEntry) {
                this.emit(OPS.GET_GLOBAL);
                this.emit(this.addConstant("in"));
                this.emit(OPS.GET_GLOBAL);
                this.emit(this.addConstant("__dk_flags"));
                this.emit(OPS.CALL);
                this.emit(1);
                this.emit(OPS.POP); 
            }
        }

        this.emitConstant(null); 
        this.emit(OPS.RETURN);

        this.compilerInvariant(this.scopeDepth === compileSnapshot.scopeDepth, `compile exit: scopeDepth leaked (${compileSnapshot.scopeDepth} -> ${this.scopeDepth})`);
        this.compilerInvariant(this.loopStack.length === compileSnapshot.loopDepth, `compile exit: loopStack leaked (${compileSnapshot.loopDepth} -> ${this.loopStack.length})`);
        this.compilerInvariant(this.switchStack.length === compileSnapshot.switchDepth, `compile exit: switchStack leaked (${compileSnapshot.switchDepth} -> ${this.switchStack.length})`);
        this.compilerInvariant(this.locals.length === compileSnapshot.localsDepth, `compile exit: locals stack leaked (${compileSnapshot.localsDepth} -> ${this.locals.length})`);
        this.compilerInvariant(this.upvalues.length === compileSnapshot.upvaluesDepth, `compile exit: upvalues stack leaked (${compileSnapshot.upvaluesDepth} -> ${this.upvalues.length})`);
        this.compilerInvariant(this.fnContext.length === compileSnapshot.fnContextDepth, `compile exit: fnContext leaked (${compileSnapshot.fnContextDepth} -> ${this.fnContext.length})`);

        if (this.debugStack) this.validateStack(this.functions[0]);
        
        return this.functions[0];
    }

    validateStack(fn) {
        const OPS = window.OPS || {};
        const OP_NAMES = window.OP_NAMES || {};
        const code = fn.code || [];
        const visited = new Map(); // Track visited IPs so we don't infinitely loop
        const formatWindow = (centerIp) => {
            const start = Math.max(0, centerIp - 8);
            const end = Math.min(code.length - 1, centerIp + 8);
            const lines = [];
            for (let i = start; i <= end; i++) {
                const op = code[i];
                const name = OP_NAMES[op] || `OP_${op}`;
                const srcLine = fn.codeLines && fn.codeLines[i] ? fn.codeLines[i] : "?";
                lines.push(`${i}: ${name} (${op}) [line ${srcLine}]`);
            }
            return lines.join("\n");
        };

        const traverse = (startIp, initialDepth) => {
            let ip = startIp;
            let depth = initialDepth;

            while (ip < code.length) {
                // If we've already traced this path, stop to prevent infinite loops
                if (visited.has(ip)) return;
                visited.set(ip, depth);

                const op = code[ip++];
                switch (op) {
                    case OPS.CONST: depth += 1; ip += 1; break;
                    case OPS.GET_LOCAL: depth += 1; ip += 1; break;
                    case OPS.SET_LOCAL: ip += 1; break;
                    case OPS.GET_GLOBAL: depth += 1; ip += 1; break;
                    case OPS.SET_GLOBAL: ip += 1; break;
                    case OPS.GET_FUNCTION_GLOBAL: depth += 1; ip += 1; break;
                    case OPS.POP: depth -= 1; break;
                    case OPS.DUP: depth += 1; break;
                    case OPS.DUP_SECOND: depth += 1; break;
                    case OPS.ADD: case OPS.ADD_ASSIGN: case OPS.SUB: case OPS.MUL: case OPS.DIV: case OPS.MOD:
                    case OPS.BIT_AND: case OPS.BIT_OR: case OPS.BIT_XOR:
                    case OPS.EQ: case OPS.NEQ: case OPS.LT: case OPS.GT: case OPS.LTE: case OPS.GTE:
                        depth -= 1; break;
                    case OPS.NOT: case OPS.AND: case OPS.OR:
                        break;
                    case OPS.JUMP: {
                        const offset = (code[ip] << 8) | code[ip + 1];
                        traverse(ip + 2 + offset, depth); // Follow the jump
                        return; // End this current path
                    }
                    case OPS.JUMP_FALSE: {
                        depth -= 1; // Pops the boolean condition
                        const offset = (code[ip] << 8) | code[ip + 1];
                        traverse(ip + 2 + offset, depth); // Branch 1: Taken
                        ip += 2; break; // Branch 2: Fallthrough
                    }
                    case OPS.LOOP: {
                        const offset = (code[ip] << 8) | code[ip + 1];
                        traverse(ip + 2 - offset, depth); // Follow loop backwards
                        return;
                    }
                    case OPS.CALL: { const argc = code[ip++]; depth -= argc; break; }
                    case OPS.INVOKE: { ip += 1; const argc = code[ip++]; depth -= argc; break; }
                    case OPS.RETURN: depth -= 1; return;
                    case OPS.BUILD_ARRAY: { const count = code[ip++]; depth += 1 - count; break; }
                    case OPS.BUILD_VECTOR: { const count = code[ip++]; depth += 1 - count; break; }
                    case OPS.BUILD_MAP: { const count = code[ip++]; depth += 1 - (count * 2); break; }
                    case OPS.GET_INDEX: depth -= 1; break;
                    case OPS.SET_INDEX: depth -= 2; break;
                    case OPS.ALIAS_KEY: depth -= 3; break;
                    case OPS.GET_INDEX_BASE: depth -= 2; break;
                    case OPS.SET_INDEX_BASE: depth -= 3; break;
                    case OPS.SLICE: depth -= 2; break;
                    case OPS.REBASE: depth -= 1; break;
                    case OPS.BUILD_REGEX: depth -= 1; break;
                    case OPS.BUILD_RANGE: depth -= 2; break;
                    case OPS.UNPACK: { const count = code[ip++]; depth += count - 1; break; }
                    case OPS.BOOL_SELECT: depth -= 2; break;
                    case OPS.GET_PROP: depth += 0; ip += 1; break;
                    case OPS.SET_PROP: depth -= 1; ip += 1; break;
                    case OPS.TRY_BEGIN: {
                        const offset = (code[ip] << 8) | code[ip + 1];
                        traverse(ip + 2 + offset, depth); // Catch block path
                        ip += 2; break; // Try block path
                    }
                    case OPS.TRY_END: break;
                    case OPS.THROW: depth -= 1; return;
                    case OPS.IMPORT: depth += 0; break;
                    case OPS.BUILD_CLASS: depth += 0; ip += 1; break;
                    case OPS.METHOD_DEF: depth -= 1; ip += 1; break;
                    case OPS.CLOSURE: {
                        const funcIdx = code[ip++]; 
                        const func = fn.constants[funcIdx];
                        const upCount = func ? func.upvalueCount || 0 : 0;
                        depth += 1;
                        ip += upCount * 2;
                        break;
                    }
                    case OPS.GET_UPVALUE: depth += 1; ip += 1; break;
                    case OPS.SET_UPVALUE: ip += 1; break;
                    case OPS.CLOSE_UPVALUE: break;
                    case OPS.FOR_RANGE: depth -= 1; ip += 1; break;
                    case OPS.FOR_RANGE_END: break;
                    case OPS.BUILD_NEURAL: {
                        // contract, limit, terrain, cases, withExpr -> neural object
                        if (depth >= 5) depth = depth - 5 + 1;
                        else depth = 1;
                        break;
                    }
                    case OPS.BUILD_BRAIN: {
                        // BUILD_BRAIN consumes 14 configuration parameters and pushes 1 output object
                        if (depth >= 14) depth = depth - 14 + 1;
                        else depth = 1;
                        break;
                    }
                    case OPS.BUILD_SOLVER: {
                        // domain, names, rules, prefer, optimize, mode, limit, timeout -> solver result
                        if (depth >= 8) depth = depth - 8 + 1;
                        else depth = 1;
                        break;
                    }
                    default:
                    // Advance past standard single-byte or multi-byte operands safely if unknown
                    break;
                }
                
                if (depth < 0) {
                    this.error(
                        `Stack underflow in validation at ip=${ip - 1} op=${op}\n` +
                        formatWindow(ip - 1)
                    );
                }
            }
        };
        
        traverse(0, 0); // Start tracing from the beginning
    }

    getName(token) {
        if (token == null) return null;
        if (typeof token === 'string' || token instanceof String) return String(token).trim();
        const name = token.value || token.lexeme || token.text || token.id;
        if (!name && token.name) return this.getName(token.name);
        return name ? String(name).trim() : null;
    }

    getSolverDomainNames(domainNode) {
        if (!domainNode || domainNode.type !== 'ArrayLiteral') return [];
        const names = [];
        for (const el of domainNode.elements || []) {
            if (el && el.type === 'MapEntry') {
                const name = this.getName(el.key);
                if (name) names.push(name);
            }
        }
        return names;
    }

    emitSolverClosure(exprNode, paramNames) {
        const fnNode = {
            type: 'FunctionDef',
            name: null,
            params: (paramNames || []).map(name => ({ value: name })),
            body: [{ type: 'Return', value: exprNode }]
        };
        this.visit(fnNode);
    }

    emitChunkedArray(itemCount, emitItem, chunkSize = 128) {
        const total = Math.max(0, Number(itemCount) || 0);
        if (total === 0) {
            this.emit(OPS.BUILD_ARRAY);
            this.emit(0);
            return;
        }

        if (total <= chunkSize) {
            for (let i = 0; i < total; i++) emitItem(i);
            this.emit(OPS.BUILD_ARRAY);
            this.emit(total);
            return;
        }

        let produced = 0;
        let chunkCount = 0;
        while (produced < total) {
            const take = Math.min(chunkSize, total - produced);
            for (let i = 0; i < take; i++) emitItem(produced + i);
            this.emit(OPS.BUILD_ARRAY);
            this.emit(take);
            produced += take;
            chunkCount++;
        }
        this.emit(OPS.BUILD_ARRAY);
        this.emit(chunkCount);
    }

visitBlock(nodes, keepLast = false) {
    if (!Array.isArray(nodes)) { this.visit(nodes); return false; }
    let hasValue = false;
    
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        
        let effectiveNode = n;
        if (n && n.type === 'Stmt') effectiveNode = n.value;

        // Track stack effect for this specific node
        this.visitWithDebug(nodes[i]);
        
        if (this.isExpression(effectiveNode)) {
            if (keepLast && i === nodes.length - 1 && !effectiveNode._localDecl) {
                hasValue = true;
            } else if (!effectiveNode._localDecl) {
                this.emit(window.OPS.POP);
            }
        }
    }
    return hasValue;
}

visitWithDebug(node) {
    const spBefore = this.currentFunction().code.length;
    this.visit(node);
    const spAfter = this.currentFunction().code.length;
    
    // Log if a node type that should be a statement leaves something on stack
    if (this.isExpression(node) && !node._localDecl) {
        // This is expected to produce a value, we must ensure it's popped if unused
    }
}

    compilerInvariant(condition, message) {
        if (!condition) this.error(`[INVARIANT] ${message}`);
    }

    snapshotCompilerState() {
        return {
            scopeDepth: this.scopeDepth,
            loopDepth: this.loopStack.length,
            switchDepth: this.switchStack.length,
            localsDepth: this.locals.length,
            upvaluesDepth: this.upvalues.length,
            fnContextDepth: this.fnContext.length
        };
    }

    snapshotCompilerControlState() {
        return {
            scopeDepth: this.scopeDepth,
            loopDepth: this.loopStack.length,
            switchDepth: this.switchStack.length,
            fnContextDepth: this.fnContext.length,
            upvaluesDepth: this.upvalues.length,
            loopSignature: JSON.stringify(this.loopStack.map(loop => ({
                kind: loop?.kind || null,
                breaks: Array.isArray(loop?.breaks) ? loop.breaks.length : null,
                continues: Array.isArray(loop?.continues) ? loop.continues.length : null
            }))),
            switchSignature: JSON.stringify(this.switchStack.map(sw => ({
                endJumps: Array.isArray(sw?.endJumps) ? sw.endJumps.length : null
            }))),
            fnContextSignature: JSON.stringify(this.fnContext.map(ctx => ({
                name: ctx?.name || null,
                isMethod: !!ctx?.isMethod,
                isInitializer: !!ctx?.isInitializer
            })))
        };
    }

    assertCompilerStateRestored(before, label) {
        this.compilerInvariant(this.scopeDepth === before.scopeDepth, `${label}: scopeDepth leaked (${before.scopeDepth} -> ${this.scopeDepth})`);
        this.compilerInvariant(this.loopStack.length === before.loopDepth, `${label}: loopStack leaked (${before.loopDepth} -> ${this.loopStack.length})`);
        this.compilerInvariant(this.switchStack.length === before.switchDepth, `${label}: switchStack leaked (${before.switchDepth} -> ${this.switchStack.length})`);
        this.compilerInvariant(this.locals.length === before.localsDepth, `${label}: locals stack leaked (${before.localsDepth} -> ${this.locals.length})`);
        this.compilerInvariant(this.upvalues.length === before.upvaluesDepth, `${label}: upvalues stack leaked (${before.upvaluesDepth} -> ${this.upvalues.length})`);
        this.compilerInvariant(this.fnContext.length === before.fnContextDepth, `${label}: fnContext leaked (${before.fnContextDepth} -> ${this.fnContext.length})`);
    }

    assertCompilerControlStateRestored(before, label) {
        this.compilerInvariant(this.scopeDepth === before.scopeDepth, `${label}: scopeDepth leaked (${before.scopeDepth} -> ${this.scopeDepth})`);
        this.compilerInvariant(this.loopStack.length === before.loopDepth, `${label}: loopStack leaked (${before.loopDepth} -> ${this.loopStack.length})`);
        this.compilerInvariant(this.switchStack.length === before.switchDepth, `${label}: switchStack leaked (${before.switchDepth} -> ${this.switchStack.length})`);
        this.compilerInvariant(this.fnContext.length === before.fnContextDepth, `${label}: fnContext leaked (${before.fnContextDepth} -> ${this.fnContext.length})`);
        this.compilerInvariant(this.upvalues.length === before.upvaluesDepth, `${label}: upvalues leaked (${before.upvaluesDepth} -> ${this.upvalues.length})`);
        this.compilerInvariant(before.loopSignature === JSON.stringify(this.loopStack.map(loop => ({
            kind: loop?.kind || null,
            breaks: Array.isArray(loop?.breaks) ? loop.breaks.length : null,
            continues: Array.isArray(loop?.continues) ? loop.continues.length : null
        }))), `${label}: loop patch state changed unexpectedly`);
        this.compilerInvariant(before.switchSignature === JSON.stringify(this.switchStack.map(sw => ({
            endJumps: Array.isArray(sw?.endJumps) ? sw.endJumps.length : null
        }))), `${label}: switch patch state changed unexpectedly`);
        this.compilerInvariant(before.fnContextSignature === JSON.stringify(this.fnContext.map(ctx => ({
            name: ctx?.name || null,
            isMethod: !!ctx?.isMethod,
            isInitializer: !!ctx?.isInitializer
        }))), `${label}: fnContext metadata changed unexpectedly`);
    }

    visit(node) {
        if (!node) return;
        if (Array.isArray(node)) { this.visitBlock(node, false); return; }
        if (node.line) { this.currentLine = node.line; }

        switch (node.type) {
            case 'Program':
            case 'Block': 
            case 'BlockStatement': {
                const blockSnapshot = this.snapshotCompilerControlState();
                this.beginScope();
                this.visitBlock(node.body || node.statements, false);
                this.endScope();
                this.assertCompilerControlStateRestored(blockSnapshot, `${node.type} exit`);
                break;
            }

            case 'Stmt':
                if (node.value) this.visit(node.value);
                break;

            case 'Identifier': 
            case 'Var':
                const varName = this.getName(node);
                // FIX: 'any' is a neural wildcard. Treat it as a literal string
                // so the VM receives it safely instead of crashing on GET_GLOBAL.
                if (varName === 'any') {
                    this.emitConstant('any');
                    break;
                }
                this.emitLoad(varName);
                break;
                
            case 'Assign': {
                const op = node.operator || node.op; 
                const isCompound = op && op !== '=';
                const rhsNode = (node.right && node.right.type === 'NeuralDef' && node.right.name)
                    ? { ...node.right, name: null }
                    : node.right;
                if (!node.left || !node.left.type) {
                    this.error("Invalid assignment target");
                    break;
                }
                const name = this.getName(node.left);

                if (node.left.type === 'Index') {
                    this.visit(node.left.target);
                    this.visit(node.left.index);
                    this.visit(rhsNode);
                    this.emit(OPS.SET_INDEX);
                    return;
                } 
                if (node.left.type === 'IndexAtBase') {
                    this.visit(rhsNode);
                    this.visit(node.left.target);
                    this.visit(node.left.index);
                    this.visit(node.left.baseArg || { type: 'Literal', value: 1 });
                    this.emit(OPS.SET_INDEX_BASE);
                    return;
                }
                
                if (node.left.type === 'Dot') {
                    this.visit(node.left.target);
                    this.emitConstant(this.getName(node.left.prop));
                    this.visit(rhsNode);
                    this.emit(OPS.SET_INDEX);
                    return;
                }

                const isSimpleVar = (node.left.type === 'Var' || node.left.type === 'Identifier');
                const normalizedName = isSimpleVar ? this.normalizeReceiverAlias(name) : name;
                let isImplicitField = false;

                if (isSimpleVar && this.inMethod) {
                    const local = this.resolveLocal(normalizedName);
                    let up = -1;
                    if (this.functions.length > 1) {
                         up = this.resolveUpvalue(this.functions.length - 2, normalizedName);
                    }
                    
                    if (local === -1 && up === -1 && !this.knownGlobals.has(normalizedName)) {
                        isImplicitField = true;
                    }
                }

                if (isCompound && isSimpleVar) {
                    if (isImplicitField) {
                        this.emit(OPS.GET_LOCAL); this.emit(0);
                        this.emit(OPS.DUP);
                        this.emit(OPS.GET_PROP); this.emit(this.addConstant(normalizedName));
                    } else {
                        this.emitLoad(normalizedName);
                    }
                }

                if (!isCompound && isImplicitField) {
                    this.emit(OPS.GET_LOCAL); this.emit(0);
                }

                this.visit(rhsNode);

                if (isCompound) {
                    const map = {'+=':OPS.ADD_ASSIGN, '-=':OPS.SUB, '*=':OPS.MUL, '/=':OPS.DIV};
                    if (map[op]) this.emit(map[op]);
                }

                if (isSimpleVar) {
                    const localIdx = this.resolveLocal(normalizedName);
                    const fnCtx = this.fnContext.length > 0 ? this.fnContext[this.fnContext.length - 1] : null;
                    const isModuleInitFn =
                        !!this.isModule &&
                        !!fnCtx &&
                        !fnCtx.isMethod &&
                        fnCtx.name === "in";
                    
                    // --- MODULE SCOPE FIX ---
    // If compiling a module at the root scope, force Global
    if (this.isModule && this.scopeDepth === 0) {
        this.knownGlobals.add(normalizedName);
        this.emit(OPS.SET_GLOBAL); 
        this.emit(this.addConstant(normalizedName));
        return; 
    }

                    if (localIdx !== -1) {
                        this.emit(OPS.SET_LOCAL); this.emit(localIdx);
                    } else if (isImplicitField) {
                        this.emit(OPS.SET_PROP); this.emit(this.addConstant(normalizedName));
                    } else {
                        let up = -1;
                        if (this.functions.length > 1) {
                             up = this.resolveUpvalue(this.functions.length - 2, normalizedName);
                        }
                        
                        if (up !== -1) {
                            this.emit(OPS.SET_UPVALUE); this.emit(up);
                        } else if (isModuleInitFn) {
                            // In module scripts, treat assignments inside in()
                            // as exports so `use module` can expose them.
                            this.knownGlobals.add(normalizedName);
                            this.emit(OPS.SET_GLOBAL);
                            this.emit(this.addConstant(normalizedName));
                        } else if (this.scopeDepth > 0 && !this.knownGlobals.has(normalizedName)) {
                            // A first local assignment keeps its value on the stack as the slot.
                            this.currentLocals().push({ name: normalizedName, depth: this.scopeDepth, stackBound: true });
                            node._localDecl = true;
                            const localSlot = this.currentLocals().length - 1;
                            this.emit(OPS.SET_LOCAL);
                            this.emit(localSlot);
                        } else {
                            this.knownGlobals.add(normalizedName);
                            this.emit(OPS.SET_GLOBAL); this.emit(this.addConstant(normalizedName));
                        }
                    }
                } else {
                    this.emitStore(normalizedName);
                }
                break;
            }

            case 'FunctionDef': {
                const name = node.name ? this.getName(node.name) : null;
                if (name) {
                    this.declaredFunctions.add(name);
                }
                const prevInMethod = this.inMethod;
                const prevIsInit = this.isInitializer; 
                const enclosingCtx = this.fnContext.length > 0 ? this.fnContext[this.fnContext.length - 1] : null;
                const bindGlobalInEntry =
                    !!name &&
                    !node.isMethod &&
                    this.scopeDepth > 0 &&
                    !!enclosingCtx &&
                    !enclosingCtx.isMethod &&
                    enclosingCtx.name === "in";
                
                // If this is a named function in a local scope, predeclare the
                // local slot so the function can reference itself via upvalue.
                let localSlot = -1;
                if (name && !node.isMethod && this.scopeDepth > 0 && !bindGlobalInEntry) {
                    localSlot = this.resolveLocal(name);
                    if (localSlot === -1) {
                        this.emitConstant(null);
                        this.currentLocals().push({ name, depth: this.scopeDepth, stackBound: true });
                        localSlot = this.currentLocals().length - 1;
                    }
                }

                const outerSnapshot = this.snapshotCompilerState();
                const savedScopeDepth = this.scopeDepth;
                const savedLoopStack = this.loopStack;
                const savedSwitchStack = this.switchStack;
                let fnCtxPushed = false;
                let fn = null;
                let upvals = [];

                // Isolate nested function compilation state so control-flow patch lists
                // cannot leak in/out of outer compilation contexts.
                this.scopeDepth = 0;
                this.loopStack = [];
                this.switchStack = [];

                try {
                    this.inMethod = !!node.isMethod;
                    this.isInitializer = (this.inMethod && name === "in");
                    this.fnContext.push({
                        name: name || "<anon>",
                        isMethod: this.inMethod,
                        isInitializer: this.isInitializer
                    });
                    fnCtxPushed = true;

                    this.functions.push(new ObjFunction(name || "<anon>"));
                    this.locals.push([]); 
                    this.upvalues.push([]);
                    
                    this.scopeDepth++; 
                    
                    if (node.isMethod) {
                        this.currentLocals().push({ name: "self", depth: this.scopeDepth, stackBound: true });
                    }
                    for (let p of (node.params || [])) {
                        this.currentLocals().push({ name: this.getName(p), depth: this.scopeDepth, stackBound: true });
                    }
                    // Reserve stable local slots for implicit assignments within this function body.
                    // Skip module init `in()` so assignments remain exportable globals.
                    const isModuleInitFn =
                        !!this.isModule &&
                        !!name &&
                        !node.isMethod &&
                        name === "in";
                    if (!isModuleInitFn) {
                        this.predeclareImplicitLocals(node.body);
                    }
                    
                    const hasValue = this.visitBlock(node.body, true);
                    
                    if (this.isInitializer) {
                        this.emit(OPS.GET_LOCAL); this.emit(0);
                    } else if (!hasValue) {
                        this.emitConstant(null);
                    }
                    this.emit(OPS.RETURN);
                    
                    upvals = this.upvalues.pop();
                    fn = this.functions.pop();
                    fn.upvalueCount = upvals.length;
                    this.locals.pop(); 
                    
                    this.scopeDepth--; 

                    this.compilerInvariant(this.loopStack.length === 0, `FunctionDef ${name || "<anon>"}: unresolved loop frames in nested compilation`);
                    this.compilerInvariant(this.switchStack.length === 0, `FunctionDef ${name || "<anon>"}: unresolved switch frames in nested compilation`);
                    this.compilerInvariant(this.scopeDepth === 0, `FunctionDef ${name || "<anon>"}: scopeDepth not restored inside nested compilation`);
                } finally {
                    if (fnCtxPushed && this.fnContext.length > 0) this.fnContext.pop();
                    this.inMethod = prevInMethod;
                    this.isInitializer = prevIsInit;
                    this.scopeDepth = savedScopeDepth;
                    this.loopStack = savedLoopStack;
                    this.switchStack = savedSwitchStack;
                }

                this.emit(OPS.CLOSURE); 
                this.emit(this.addConstant(fn));
                for(let u of upvals) { 
                    this.emit(u.isLocal ? 1 : 0); 
                    this.emit(u.index); 
                }
                
                if (name && !node.isMethod) { 
                    if (this.scopeDepth === 0 || bindGlobalInEntry) { 
                        this.emit(OPS.SET_GLOBAL);
                        this.emit(this.addConstant(name));
                        this.knownGlobals.add(name);
                        this.emit(OPS.POP); 
                    } else {
                        if (localSlot === -1) localSlot = this.resolveLocal(name);
                        this.emit(OPS.SET_LOCAL);
                        this.emit(localSlot);
                        this.emit(OPS.POP); // FIX: Pop the closure after local assignment
                    }
                }

                this.assertCompilerStateRestored(outerSnapshot, `FunctionDef ${name || "<anon>"} exit`);
                break;
            }

            case 'ClassDef': {
                const classSnapshot = this.snapshotCompilerState();
                const name = this.getName(node.name);
                const isLocalClass = this.scopeDepth > 0 && !this.inMethod;
                let localSlot = -1;

                if (isLocalClass) {
                    localSlot = this.resolveLocal(name);
                    if (localSlot === -1) {
                        // Reserve a real stack slot for the class binding in local scopes.
                        this.emitConstant(null);
                        this.currentLocals().push({ name, depth: this.scopeDepth, isClass: true, stackBound: true });
                        localSlot = this.currentLocals().length - 1;
                    }
                }

                if (node.parent) {
                    this.emitLoad(this.getName(node.parent)); 
                } else {
                    this.emitConstant(null);
                }
                
                this.emit(OPS.BUILD_CLASS);
                this.emit(this.addConstant(name));
                
                // === FIX START: Register Global Early ===
                // We must mark the class name as known BEFORE compiling methods
                // so that recursive calls like 'Tree(...)' inside the class 
                // resolve to the global class, not 'self.Tree'.
                if (!isLocalClass) {
                    this.knownGlobals.add(name);
                }
                // === FIX END ===
                
                for (let m of node.methods) {
                    m.isMethod = true;
                    this.visit(m); 
                    m.isMethod = false;
                    this.emit(OPS.METHOD_DEF);
                    this.emit(this.addConstant(this.getName(m.name)));
                }
                
                if (!isLocalClass) {
                    this.emit(OPS.SET_GLOBAL); 
                    this.emit(this.addConstant(name));
                    this.emit(OPS.POP);
                } else {
                    this.emit(OPS.SET_LOCAL);
                    this.emit(localSlot);
                    this.emit(OPS.POP);
                }
                this.assertCompilerStateRestored(classSnapshot, `ClassDef ${name || "<anon-class>"} exit`);
                break;
            }
            
            case 'If': {
                this.visit(node.cond);
                const thenJump = this.emitJump(OPS.JUMP_FALSE);
                this.visit(node.body || node.then);
                const elseJump = this.emitJump(OPS.JUMP);
                this.patchJump(thenJump);
                if (node.elseBody || node.else) this.visit(node.elseBody || node.else);
                this.patchJump(elseJump);
                break;
            }

            case 'Break': {
                if (this.loopStack.length === 0) this.error("Break outside loop");
                const j = this.emitJump(OPS.JUMP);
                const loop = this.loopStack[this.loopStack.length - 1];
                this.compilerInvariant(Array.isArray(loop.breaks), "Break: active loop frame missing break patch list");
                loop.breaks.push(j);
                break;
            }

            case 'Continue': {
                if (this.loopStack.length === 0) this.error("Continue outside loop");
                const j = this.emitJump(OPS.JUMP);
                // Push the jump to the 'continues' array of the current loop level
                const loop = this.loopStack[this.loopStack.length - 1];
                this.compilerInvariant(Array.isArray(loop.continues), "Continue: active loop frame missing continue patch list");
                loop.continues.push(j);
                break;
            }

            case 'While': {
                const loopDepthBefore = this.loopStack.length;
                const scopeBefore = this.scopeDepth;
                const start = this.currentFunction().code.length;
                
                // FIX: Initialize with BOTH breaks and continues arrays
                this.loopStack.push({ kind: "while", start, breaks: [], continues: [] });
                
                this.visit(node.cond);
                const exitJump = this.emitJump(OPS.JUMP_FALSE);
                
                this.visit(node.body);
                
                const loop = this.loopStack.pop();
                
                // LAND CONTINUES HERE: Jump to the start of the condition
                for (let c of loop.continues) {
                    this.patchJump(c);
                }
                loop.continues.length = 0;
                
                this.emitLoop(start);
                this.patchJump(exitJump);
                
                // LAND BREAKS HERE: Jump to the end of the loop
                for (let b of loop.breaks) {
                    this.patchJump(b);
                }
                loop.breaks.length = 0;
                this.compilerInvariant(loop.continues.length === 0 && loop.breaks.length === 0, "While: unresolved break/continue patch list");
                this.compilerInvariant(this.loopStack.length === loopDepthBefore, "While: loopStack depth mismatch after compile");
                this.compilerInvariant(this.scopeDepth === scopeBefore, "While: scopeDepth changed unexpectedly");
                break;
            }

            case 'For': {
                const loopDepthBefore = this.loopStack.length;
                const scopeBefore = this.scopeDepth;
                this.beginScope();
                if (node.isRange) {
                    const iVar = this.getName(node.varName);
                    this.emitConstant(null);
                    this.currentLocals().push({ name: iVar, depth: this.scopeDepth, stackBound: true });
                    const loopVarIdx = this.currentLocals().length - 1;
                    this.visit(node.start);
                    this.emit(OPS.SET_LOCAL); this.emit(loopVarIdx);
                    this.emit(OPS.POP);
                    
                    this.emitConstant(null);
                    this.currentLocals().push({ name: "(range_end)", depth: this.scopeDepth, stackBound: true });
                    const endIdx = this.currentLocals().length - 1;
                    this.visit(node.end);
                    this.emit(OPS.SET_LOCAL); this.emit(endIdx);
                    this.emit(OPS.POP);
                    
                    this.emitConstant(null);
                    this.currentLocals().push({ name: "(range_step)", depth: this.scopeDepth, stackBound: true });
                    const stepIdx = this.currentLocals().length - 1;
                    if (node.step && node.step.type === 'Assign' && (node.step.op === '+=' || node.step.op === '-=') && this.getName(node.step.left) === iVar) {
                        this.visit(node.step.right);
                        if (node.step.op === '-=') { this.emitConstant(-1); this.emit(OPS.MUL); }
                    } else if (node.step) { 
                        this.visit(node.step); 
                    } else {
                        // Default step: if (end >= start) 1 else -1
                        this.emit(OPS.GET_LOCAL); this.emit(endIdx);
                        this.emit(OPS.GET_LOCAL); this.emit(loopVarIdx);
                        this.emit(OPS.GTE);
                        const negStepJump = this.emitJump(OPS.JUMP_FALSE);
                        this.emitConstant(1);
                        const stepDoneJump = this.emitJump(OPS.JUMP);
                        this.patchJump(negStepJump);
                        this.emitConstant(-1);
                        this.patchJump(stepDoneJump);
                    }
                    this.emit(OPS.SET_LOCAL); this.emit(stepIdx);
                    this.emit(OPS.POP);
                    
                    this.predeclareImplicitLocals(node.body);

                    const loopStart = this.currentFunction().code.length;
                    const rangeDebugStart = loopStart;
                    this.loopStack.push({ kind: "for-range", breaks: [], continues: [] });

                    // cond = (step > 0 && i <= end) || (step < 0 && i >= end)
                    this.emit(OPS.GET_LOCAL); this.emit(stepIdx);
                    this.emitConstant(0);
                    this.emit(OPS.GT);
                    this.emit(OPS.GET_LOCAL); this.emit(loopVarIdx);
                    this.emit(OPS.GET_LOCAL); this.emit(endIdx);
                    this.emit(OPS.LTE);
                    this.emit(OPS.AND);

                    this.emit(OPS.GET_LOCAL); this.emit(stepIdx);
                    this.emitConstant(0);
                    this.emit(OPS.LT);
                    this.emit(OPS.GET_LOCAL); this.emit(loopVarIdx);
                    this.emit(OPS.GET_LOCAL); this.emit(endIdx);
                    this.emit(OPS.GTE);
                    this.emit(OPS.AND);
                    this.emit(OPS.OR);

                    const exitJump = this.emitJump(OPS.JUMP_FALSE);

                    this.visit(node.body);

                    const loop = this.loopStack.pop();
                    for (let c of loop.continues) this.patchJump(c);
                    loop.continues.length = 0;

                    // i += step
                    this.emit(OPS.GET_LOCAL); this.emit(loopVarIdx);
                    this.emit(OPS.GET_LOCAL); this.emit(stepIdx);
                    this.emit(OPS.ADD);
                    this.emit(OPS.SET_LOCAL); this.emit(loopVarIdx);
                    this.emit(OPS.POP);

                    this.emitLoop(loopStart);
                    this.patchJump(exitJump);

                    for (let b of loop.breaks) this.patchJump(b);
                    loop.breaks.length = 0;
                    this.compilerInvariant(loop.continues.length === 0 && loop.breaks.length === 0, "For(range): unresolved break/continue patch list");

                    if (this.debugRangeTrace) {
                        const fn = this.currentFunction();
                        const code = fn.code;
                        const OP_NAMES = window.OP_NAMES || {};
                        const rangeDebugEnd = code.length;
                        const lines = [];
                        const OPS_MAP = (typeof window !== 'undefined' && window.OPS) ? window.OPS : {};
                        const oneArgOps = new Set([
                            OPS_MAP.CONST, OPS_MAP.GET_LOCAL, OPS_MAP.SET_LOCAL,
                            OPS_MAP.GET_GLOBAL, OPS_MAP.SET_GLOBAL,
                            OPS_MAP.GET_UPVALUE, OPS_MAP.SET_UPVALUE,
                            OPS_MAP.CALL, OPS_MAP.BUILD_ARRAY, OPS_MAP.BUILD_MAP,
                            OPS_MAP.REBASE, OPS_MAP.UNPACK, OPS_MAP.BUILD_CLASS,
                            OPS_MAP.METHOD_DEF, OPS_MAP.FOR_RANGE, OPS_MAP.IMPORT,
                            OPS_MAP.GET_INDEX_BASE, OPS_MAP.SET_INDEX_BASE
                        ]);
                        const twoArgJumpOps = new Set([OPS_MAP.JUMP, OPS_MAP.JUMP_FALSE, OPS_MAP.LOOP, OPS_MAP.TRY_BEGIN]);

                        for (let p = rangeDebugStart; p < rangeDebugEnd;) {
                            const op = code[p];
                            const name = OP_NAMES[op] || `OP_${op}`;
                            if (twoArgJumpOps.has(op) && p + 2 < rangeDebugEnd) {
                                const hi = code[p + 1], lo = code[p + 2];
                                const off = ((hi << 8) | lo) >>> 0;
                                let target = "?";
                                if (op === OPS_MAP.JUMP || op === OPS_MAP.JUMP_FALSE) target = p + 3 + off;
                                if (op === OPS_MAP.LOOP) target = p + 3 - off;
                                lines.push(`${p}: ${name} (${op}) ${off} -> ${target}`);
                                p += 3;
                                continue;
                            }
                            if (oneArgOps.has(op) && p + 1 < rangeDebugEnd) {
                                lines.push(`${p}: ${name} (${op}) ${code[p + 1]}`);
                                p += 2;
                                continue;
                            }
                            lines.push(`${p}: ${name} (${op})`);
                            p += 1;
                        }
                        const msg = `[RANGE-TRACE] var=${iVar} line=${this.currentLine}\n` + lines.join("\n");
                        if (this.logger) this.logger(msg);
                        if (typeof console !== 'undefined' && console.log) console.log(msg);
                    }

                } else {
                    // Branch for conditional loops: for i < 10
                    if(node.init) { 
                        this.visit(node.init); 
                        if (this.isExpression(node.init) && !node.init._localDecl) this.emit(OPS.POP); 
                    }
                    this.predeclareImplicitLocals(node.body);
                    const start = this.currentFunction().code.length;
                    
                    // Initialize with BOTH 'breaks' AND 'continues'
                    this.loopStack.push({ kind: "for-cond", start, breaks: [], continues: [] });
                    
                    let exitJump = -1;
                    if(node.cond) { 
                        this.visit(node.cond); 
                        exitJump = this.emitJump(OPS.JUMP_FALSE); 
                    }
                    
                    this.visit(node.body);
                    
                    // 1. Pop current loop metadata
                    const loop = this.loopStack.pop();

                    // 2. LAND CONTINUES HERE (Jump to increment/condition check)
                    for (let c of loop.continues) this.patchJump(c);
                    loop.continues.length = 0;
                    
                    const incNode = node.inc || node.step || node.update || node.next || node.action || node.after;
                    if(incNode) { 
                        this.visit(incNode); 
                        this.emit(OPS.POP); 
                    }
                    
                    // 3. Jump back to top
                    this.emitLoop(start);

                    // 4. LAND BREAKS HERE (And conditional failure)
                    if(exitJump !== -1) { this.patchJump(exitJump); }
                    for (let b of loop.breaks) this.patchJump(b);
                    loop.breaks.length = 0;
                    this.compilerInvariant(loop.continues.length === 0 && loop.breaks.length === 0, "For(cond): unresolved break/continue patch list");
                }
                this.endScope(); 
                this.compilerInvariant(this.loopStack.length === loopDepthBefore, "For: loopStack depth mismatch after compile");
                this.compilerInvariant(this.scopeDepth === scopeBefore, "For: scopeDepth mismatch after compile");
                break;
            }

            case 'Switch': {
                const switchDepthBefore = this.switchStack.length;
                this.switchStack.push({ endJumps: [] });
                try {
                    // 1. Evaluate the test expression and leave it on the stack
                    this.visit(node.test); // Stack: [testVal]
                    const endJumps = this.switchStack[this.switchStack.length - 1].endJumps;
                    
                    for (const c of node.cases) {
                        // Compare: Is testVal == caseVal?
                        this.emit(OPS.DUP);    // Stack: [testVal, testVal]
                        this.visit(c.value);   // Stack: [testVal, testVal, caseVal]
                        this.emit(OPS.EQ);     // Stack: [testVal, bool]
                        
                        // Jump to next case if this one doesn't match
                        const nextJump = this.emitJump(OPS.JUMP_FALSE);
                        
                        // MATCH FOUND:
                        this.emit(OPS.POP);    // Pop the extra [testVal]
                        this.visitBlock(c.body); 
                        
                        // Auto-Break: Jump to the end of the switch
                        endJumps.push(this.emitJump(OPS.JUMP));
                        
                        // Land here if the comparison failed
                        this.patchJump(nextJump);
                    }
                    
                    // 2. Default Case
                    // If we reached here, no cases matched. Pop the original [testVal].
                    this.emit(OPS.POP); 
                    if (node.defaultBody) {
                        this.visitBlock(node.defaultBody);
                    }
                    
                    // 3. Patch all the "Auto-Breaks" to land here at the very end
                    for (const j of endJumps) {
                        this.patchJump(j);
                    }
                    endJumps.length = 0;
                } finally {
                    if (this.switchStack.length > switchDepthBefore) {
                        this.switchStack.pop();
                    }
                }
                this.compilerInvariant(this.switchStack.length === switchDepthBefore, "Switch: switchStack depth mismatch after compile");
                break;
            }

            case 'Use': {
                let alias = node.alias;
                if (!alias) {
                    const parts = node.path.split('/');
                    alias = parts[parts.length - 1].split('.')[0];
                }
                const aliasName = alias ? this.getName(alias) : null;
                const fnCtx = this.fnContext.length > 0 ? this.fnContext[this.fnContext.length - 1] : null;
                const inEntry = !!fnCtx && !fnCtx.isMethod && fnCtx.name === "in";

                // Treat imports in entry-point `in()` as globals (module-style),
                // so they're not shadowed by locals.
                if (aliasName && this.scopeDepth > 0 && !inEntry) {
                    // Reserve or reuse local slot first, then assign imported module into it.
                    let slot = this.resolveLocal(aliasName);
                    if (slot === -1) {
                        this.emitConstant(null);
                        this.currentLocals().push({ name: aliasName, depth: this.scopeDepth, stackBound: true });
                        slot = this.currentLocals().length - 1;
                    }
                    
                    this.emitConstant(node.path);
                    this.emit(OPS.IMPORT);
                    this.emit(OPS.SET_LOCAL);
                    this.emit(slot);
                    this.emit(OPS.POP);
                } else {
                    this.emitConstant(node.path);
                    this.emit(OPS.IMPORT);
                    if (aliasName) { 
                        this.emitStore(aliasName); 
                    }
                    this.emit(OPS.POP); 
                }
                break;
            }

            case 'DestructuringAssignment':
            case 'Destructure': {
                // 1. Evaluate the right side (the array to destructure)
                this.visit(node.right); 
                
                const targets = Array.isArray(node.left) ? node.left : (Array.isArray(node.names) ? node.names : []);

                // 2. Extract each variable
                for (let i = 0; i < targets.length; i++) {
                    let idNode = targets[i];
                    if (!idNode) continue; 
                    
                    const id = typeof idNode === 'string' ? idNode : this.getName(idNode);
                    if (!id) continue;
                    
                    // Duplicate the array so we don't consume it
                    this.emit(OPS.DUP);
                    
                    // Push the index we want to extract (Base 1)
                    this.emit(OPS.CONST);
                    this.emit(this.addConstant(i + 1)); 
                    
                    // Get the value at that index
                    this.emit(OPS.GET_INDEX);
                    
                    // Assign it to the target variable
                    if (this.scopeDepth === 0) {
                        this.emit(OPS.SET_GLOBAL);
                        this.emit(this.addConstant(id));
                        this.knownGlobals.add(id);
                        this.emit(OPS.POP); // Pop the assigned value
                    } else {
                        let slot = this.resolveLocal(id);
                        if (slot === -1) {
                            this.emitConstant(null);
                            this.currentLocals().push({ name: id, depth: this.scopeDepth, isCaptured: false, stackBound: true });
                            slot = this.currentLocals().length - 1;
                        }
                        this.emit(OPS.SET_LOCAL);
                        this.emit(slot);
                        this.emit(OPS.POP); // Pop the assigned value
                    }
                }
                
                // 3. Pop the original array we were destructuring
                this.emit(OPS.POP);
                break;
            }

            case 'Literal':
            case 'StringLiteral':
            case 'NumericLiteral':
            case 'BooleanLiteral':
                this.emitConstant(node.value); 
                break;
            case 'RegexLiteral':
                this.emitConstant(node.pattern);
                this.emitConstant(node.flags);
                this.emit(OPS.BUILD_REGEX);
                break;
            case 'Call': {
                if (node.callee && node.callee.type === 'Dot') {
                    this.visit(node.callee.target); 
                    for (let a of node.args) this.visit(a);
                    this.emit(OPS.INVOKE);
                    this.emit(this.addConstant(this.getName(node.callee.prop)));
                    this.emit(node.args.length);
                } else {
                    const func = node.callee || node.name;
                    const name = typeof func === 'string' ? func : (func && func.type === 'Var' ? func.name : null);

                    const localIdx = name ? this.resolveLocal(name) : -1;
                    const upIdx = (name && this.functions.length > 1) ? this.resolveUpvalue(this.functions.length - 2, name) : -1;

                    if (localIdx !== -1 || upIdx !== -1) {
                        this.emitLoad(name);
                    } else if (name && this.declaredFunctions.has(name)) {
                        this.emit(OPS.GET_FUNCTION_GLOBAL);
                        this.emit(this.addConstant(name));
                    } else if (name && this.builtinCallNames.has(name)) {
                        this.emit(OPS.GET_GLOBAL); 
                        this.emit(this.addConstant(`__builtin_${name}`));
                    } else if (typeof func === 'string') {
                        this.emitLoad(func);
                    } else { 
                        this.visit(func); 
                    }
                    for (const arg of node.args) this.visit(arg);
                    this.emit(OPS.CALL);
                    this.emit(node.args.length);
                }
                break;
            }

            case 'Array': 
            case 'ArrayLiteral': {
                 const els = node.elements || [];
                 const isVector = !!node.isVector; // NEW: Flag from parser
                 const onlyMapEntries = !isVector && els.length > 0 && els.every(e => e && e.type === 'MapEntry');
                 const mapEntries = [];

                 if (onlyMapEntries) {
                     for (const e of els) {
                         this.emitConstant(this.getName(e.key));
                         this.visit(e.value);
                     }
                     this.emit(OPS.BUILD_MAP);
                     this.emit(els.length);
                     break;
                 }

                 // 1. Emit elements onto the stack
                 for (let i = 0; i < els.length; i++) {
                     const e = els[i];
                     if (e && e.type === 'MapEntry') {
                         this.visit(e.value);
                         mapEntries.push({ key: this.getName(e.key), index: i + 1 });
                     } else { 
                         this.visit(e); 
                     }
                 }

                 // 2. Emit the correct Build instruction
                 if (isVector) {
                     this.emit(OPS.BUILD_VECTOR); 
                 } else {
                     this.emit(OPS.BUILD_ARRAY); 
                 }
                 this.emit(els.length);

                 // 3. Handle Map Properties (^key)
                 // Mixed arrays keep keyed values in the array body and tag the slot.
                 for (const me of mapEntries) {
                     this.emit(OPS.DUP); 
                     this.emitConstant(me.key);
                     this.emitConstant(me.index); 
                     this.emit(OPS.ALIAS_KEY);
                 }
                 break;
            }

            case 'MapLiteral': {
                const ents = node.entries || [];
                for(let e of ents) { this.visit(e.key); this.visit(e.value); }
                this.emit(OPS.BUILD_MAP); this.emit(ents.length);
                break;
            }

            case 'Rebase': 
                this.visit(node.target); if (node.baseArg) this.visit(node.baseArg); else this.emitConstant(1); this.emit(OPS.REBASE); break;
            case 'Index': 
                this.visit(node.target); this.visit(node.index); this.emit(OPS.GET_INDEX); break;
            case 'IndexAtBase':
                this.visit(node.target);
                this.visit(node.index);
                if (node.baseArg) this.visit(node.baseArg); else this.emitConstant(1);
                this.emit(OPS.GET_INDEX_BASE);
                break;
            case 'Dot': 
                this.visit(node.target); this.emitConstant(this.getName(node.prop)); this.emit(OPS.GET_INDEX); break;
            case 'Slice': 
                this.visit(node.target); this.visit(node.start); if (node.end) this.visit(node.end); else this.emitConstant(null); this.emit(OPS.SLICE); break;
            case 'Return': 
                if (this.isInitializer) {
                    if (node.value) {
                        const ctx = this.fnContext.length > 0 ? this.fnContext[this.fnContext.length - 1] : null;
                        const fnName = ctx ? ctx.name : this.currentFunction().name;
                        const valueType = node.value && node.value.type ? node.value.type : typeof node.value;
                        const creator = node._creator || "unknown";
                        this.error(`Cannot return a value from an initializer. method=${fnName} returnType=${valueType} nodeCreator=${creator}`);
                    }
                    this.emit(OPS.GET_LOCAL); this.emit(0);
                } else {
                    if(node.value) this.visit(node.value); 
                    else this.emitConstant(null); 
                }
                this.emit(OPS.RETURN); 
                break;
            case 'Throw': 
                if (node.expr) this.visit(node.expr); else this.emitConstant(null); this.emit(OPS.THROW); break;
            
            case 'TryStatement':
            case 'Try': {
                const tryNode = node.tryBlock || node.tryBody;
                const catchNode = node.catchBlock || node.catchBody;
                const errVarNode = node.catchVar || node.errVar;
                const errVarName = errVarNode ? (typeof errVarNode === 'string' ? errVarNode : errVarNode.name) : null;

                const jTry = this.emitJump(OPS.TRY_BEGIN);
                this.visit(tryNode); 
                
                // FIX: TRY_END is a single instruction, not a jump!
                this.emit(OPS.TRY_END);
                // Now jump OVER the catch block since the try succeeded
                const jSkip = this.emitJump(OPS.JUMP); 
                
                this.patchJump(jTry);
                
                if (errVarName) {
                    if (this.scopeDepth === 0) {
                        this.emit(OPS.SET_GLOBAL);
                        this.emit(this.addConstant(errVarName));
                        this.knownGlobals.add(errVarName);
                        this.emit(OPS.POP); 
                        this.visit(catchNode);
                    } else {
                        this.beginScope();
                        // The thrown error object is already on the stack. Bind that
                        // value directly as the catch local so the slot stays live.
                        this.currentLocals().push({ name: errVarName, depth: this.scopeDepth, isCaptured: false, stackBound: true });
                        const slot = this.currentLocals().length - 1;
                        
                        this.emit(OPS.SET_LOCAL);
                        this.emit(slot);
                        
                        this.visit(catchNode);
                        this.endScope(); 
                    }
                } else {
                    this.emit(OPS.POP); 
                    this.visit(catchNode);
                }
                
                this.patchJump(jSkip);
                break;
            }

            case 'Binary': {
                 if (['&&','and'].includes(node.op)) {
                    this.visit(node.left); this.emit(OPS.DUP); const j = this.emitJump(OPS.JUMP_FALSE); this.emit(OPS.POP); this.visit(node.right); this.patchJump(j);
                 } else if (['||','or'].includes(node.op)) {
                    this.visit(node.left); this.emit(OPS.DUP); const j1 = this.emitJump(OPS.JUMP_FALSE); const j2 = this.emitJump(OPS.JUMP); this.patchJump(j1); this.emit(OPS.POP); this.visit(node.right); this.patchJump(j2);
                 } else {
                    this.visit(node.left); this.visit(node.right);
                    const map = {'+':OPS.ADD, '-':OPS.SUB, '*':OPS.MUL, '/':OPS.DIV, '%':OPS.MOD, '==':OPS.EQ, '!=':OPS.NEQ, '<':OPS.LT, '>':OPS.GT, '<=':OPS.LTE, '>=':OPS.GTE, '&':OPS.BIT_AND, '|':OPS.BIT_OR, '^':OPS.BIT_XOR};
                    if(map[node.op]) this.emit(map[node.op]);
                 }
                 break;
            }
            
            case 'VarDecl':
            case 'VariableDeclaration': {
                const name = this.getName(node.name || node.declarations[0].id);
                const init = node.value || node.declarations[0].init;
                
                if (init) this.visit(init); 
                else this.emitConstant(null);
                
                if (this.isModule || this.scopeDepth === 0) {
                    this.knownGlobals.add(name);
                    this.emit(OPS.SET_GLOBAL);
                    this.emit(this.addConstant(name));
                    this.emit(OPS.POP); 
                } else {
                    this.currentLocals().push({ name, depth: this.scopeDepth, stackBound: true });
                }
                break;
            }
            case 'NeuralDef': {
                const neuralSnapshot = this.snapshotCompilerControlState();
                const netName = node.name;
                
                // Register name globally if we are at the root scope
                if (this.scopeDepth === 0 && netName) {
                    this.knownGlobals.add(netName);
                }

                // 1. Setup Data
                this.emitConstant(""); // weightFile (empty for internal terrain)
                this.emitConstant(node.limit || 0);
                
                // 2. Terrain Data (Compile AST nodes into runtime Arrays)
                const terrainRows = node.terrain || [];
                for (let i = 0; i < terrainRows.length; i++) {
                    const row = terrainRows[i];
                    this.visit(row.weights);      // Compiles the weights array
                    this.emitConstant(row.label); // Pushes the string label
                    this.emit(OPS.BUILD_ARRAY);   // Combines them into [weights, label]
                    this.emit(2);
                }
                this.emit(OPS.BUILD_ARRAY); 
                this.emit(terrainRows.length);    // Combines all rows into the terrain array

                // 3. Live Input (WITH)
                if (node.withExpr) {
                    this.visit(node.withExpr);    // Compiles the [hp, dist, etc] array
                } else {
                    this.emitConstant(null);
                }

                // 4. Case/Action Resolution
                const caseRows = node.cases || [];
                for (let i = 0; i < caseRows.length; i++) {
                    const c = caseRows[i];
                    this.emitConstant(c.label);   // Pushes the case label
                    this.visit(c.action);         // Evaluates the action (e.g. self.bite())
                    this.emit(OPS.BUILD_ARRAY);   // Combines them into [label, actionResult]
                    this.emit(2);
                }
                this.emit(OPS.BUILD_ARRAY); 
                this.emit(caseRows.length);       // Combines all cases into the cases array

                // 5. Build the Neural Object in the VM
                this.emit(OPS.BUILD_NEURAL);
                
                // 6. Final Binding (Assign it to its variable name)
                if (netName) {
                    if (this.scopeDepth === 0) {
                        this.emit(OPS.SET_GLOBAL);
                        this.emit(this.addConstant(netName));
                    } else {
                        let localSlot = this.resolveLocal(netName);
                        if (localSlot === -1) {
                            this.emitConstant(null);
                            this.currentLocals().push({ name: netName, depth: this.scopeDepth, stackBound: true });
                            localSlot = this.currentLocals().length - 1;
                        }
                        this.emit(OPS.SET_LOCAL);
                        this.emit(localSlot);
                    }
                }
                this.assertCompilerControlStateRestored(neuralSnapshot, `NeuralDef ${netName || "<anon-neural>"} exit`);
                break;
            }
            case 'BrainDef': {
                const brainSnapshot = this.snapshotCompilerControlState();
                const netName = node.name;
                
                // CRITICAL FIX: Register the name IMMEDIATELY.
                // This allows 'my_brain = brain ...' to resolve the variable
                if (netName && this.scopeDepth === 0) {
                    this.knownGlobals.add(netName);
                }

                // 1. Static Metadata (Dependencies)
                this.emitConstant(node.uses || []);
                
                // 2. Config Map
                if (node.configMap) this.visit(node.configMap);
                else this.emitConstant(null);

               // 3. Topology Legend
                // Emit as AST constant instead of evaluating it, so the VM can read parameter names
                this.emitConstant(node.legend || null);

                // 4. Topology Rows
                const topRows = node.topology || [];
                for (let i = 0; i < topRows.length; i++) {
                    this.visit(topRows[i]);
                }
                this.emit(OPS.BUILD_ARRAY);
                this.emit(topRows.length);

                // 5. Bookends & Constraints
                this.emitConstant(node.entrySize !== null ? node.entrySize : null);
                this.emitConstant(node.exitSize !== null ? node.exitSize : null);
                this.emitConstant(node.limit !== null ? node.limit : 0);

                // 6. Stop Pattern
                if (node.stopPattern) this.visit(node.stopPattern);
                else this.emitConstant(null);

                // 7. Sample Map
                if (node.sampleMap) this.visit(node.sampleMap);
                else this.emitConstant(null);

                // 8. Identity (System Prompt)
                if (node.identityStr) this.visit(node.identityStr);
                else this.emitConstant(null);

                // 9. State & Streaming
                this.emitConstant(!!node.memoryState);
                this.emitConstant(!!node.streamState);

                // 10. Callback Function
                if (node.callbackFn) this.visit(node.callbackFn);
                else this.emitConstant(null);

                // 11. The Execution Trigger (Prompt)
                if (node.promptExpr) this.visit(node.promptExpr);
                else this.emitConstant(null);

                // 12. Build the Object
                this.emit(OPS.BUILD_BRAIN);
                
                // 13. Final Binding
                if (netName) {
                    if (this.scopeDepth === 0) {
                        this.emit(OPS.SET_GLOBAL);
                        this.emit(this.addConstant(netName));
                    } else {
                        let localSlot = this.resolveLocal(netName);
                        if (localSlot !== -1) {
                            this.emit(OPS.SET_LOCAL);
                            this.emit(localSlot);
                        }
                    }
                }
                // Do NOT emit OPS.POP here so it can be used in an assignment
                this.assertCompilerControlStateRestored(brainSnapshot, `BrainDef ${netName || "<anon-brain>"} exit`);
                break;
            }
            case 'SolverDef': {
                const solverSnapshot = this.snapshotCompilerControlState();
                const solverName = node.name;
                const domainNames = this.getSolverDomainNames(node.domain);

                if (solverName && this.scopeDepth === 0) {
                    this.knownGlobals.add(solverName);
                }

                if (node.domain) this.visit(node.domain);
                else this.emitConstant(null);

                this.emitConstant(domainNames);

                const rules = node.rules || [];
                this.emitChunkedArray(rules.length, (index) => {
                    this.emitSolverClosure(rules[index], domainNames);
                });

                const prefers = node.prefer || [];
                this.emitChunkedArray(prefers.length, (index) => {
                    this.emitSolverClosure(prefers[index], domainNames);
                });

                const optimize = node.optimize || [];
                for (const opt of optimize) {
                    let kind = "bool";
                    let expr = opt;
                    if (opt && opt.type === 'ArrayLiteral' && (opt.elements || []).length === 1) {
                        const only = opt.elements[0];
                        if (only && only.type === 'MapEntry') {
                            const key = String(this.getName(only.key) || "").toLowerCase();
                            if (key === 'min' || key === 'max') {
                                kind = key;
                                expr = only.value;
                            }
                        }
                    }
                    this.emitConstant(kind);
                    this.emitSolverClosure(expr, domainNames);
                    this.emit(OPS.BUILD_ARRAY);
                    this.emit(2);
                }
                this.emit(OPS.BUILD_ARRAY);
                this.emit(optimize.length);

                if (node.mode) this.visit(node.mode);
                else this.emitConstant("first");

                if (node.limit) this.visit(node.limit);
                else this.emitConstant(100000);

                if (node.timeout) this.visit(node.timeout);
                else this.emitConstant(null);

                this.emit(OPS.BUILD_SOLVER);

                if (solverName) {
                    if (this.scopeDepth === 0) {
                        this.emit(OPS.SET_GLOBAL);
                        this.emit(this.addConstant(solverName));
                    } else {
                        let localSlot = this.resolveLocal(solverName);
                        if (localSlot !== -1) {
                            this.emit(OPS.SET_LOCAL);
                            this.emit(localSlot);
                        }
                    }
                }
                this.assertCompilerControlStateRestored(solverSnapshot, `SolverDef ${solverName || "<anon-solver>"} exit`);
                break;
            }
        }
    }

   collectImplicitLocals(node, names) {
        // FIX: Removed 'Try' so variables in try blocks are hoisted, keeping the catch stack perfectly aligned!
        const skipTypes = new Set(['FunctionDef', 'ClassDef', 'For', 'While']);
        const stack = [node];
        while (stack.length > 0) {
            const cur = stack.pop();
            if (!cur || typeof cur !== 'object') continue;
            if (Array.isArray(cur)) { for (const n of cur) stack.push(n); continue; }
            if (cur.type && skipTypes.has(cur.type)) continue;
            if (cur.type === 'Assign') {
                const op = cur.operator || cur.op;
                const isCompound = op && op !== '=';
                const left = cur.left;
                if (!isCompound && left && (left.type === 'Var' || left.type === 'Identifier')) names.add(this.getName(left));
            }
            if (cur.type === 'NeuralDef' && cur.name) {
                names.add(this.getName(cur.name));
            }
            for (const k of Object.keys(cur)) {
                if (k === 'parent' || k === 'moduleScope') continue;
                const v = cur[k];
                if (v && typeof v === 'object') stack.push(v);
            }
        }
    }

    predeclareImplicitLocals(body) {
        if (this.scopeDepth === 0 || this.inMethod) return;
        const names = new Set();
        this.collectImplicitLocals(body, names);
        for (const name of names) {
            if (!name) continue;
            if (this.knownGlobals.has(name)) continue;
            if (this.resolveLocal(name) !== -1) continue;
            // Do not shadow captured outer locals/upvalues (closure state).
            if (this.functions.length > 1) {
                const up = this.resolveUpvalue(this.functions.length - 2, name);
                if (up !== -1) continue;
            }
            // Reserve real stack-backed local slots so GET/SET_LOCAL indices stay stable.
            this.emitConstant(null);
            this.currentLocals().push({ name, depth: this.scopeDepth, stackBound: true });
        }
    }

    isExpression(node) {
        if (!node) return false;
        if (node.type === 'FunctionDef' && !node.name) return true;
        const exprTypes = [
            'Literal', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral',
            'Identifier', 'Var', 'Assign', 'Call', 'Binary', 
            'Array', 'ArrayLiteral', 'MapLiteral', 'Dot', 'Index', 'IndexAtBase', 'Slice', 'Rebase',
            'NeuralDef', 'BrainDef', 'SolverDef' // FIX: Treat AI blocks as expressions for safe stack cleanup
        ];
        return exprTypes.includes(node.type);
    }

    findInitializerReturnViolations(nodes) {
        const issues = [];
        const visitNode = (node, className = null, inInitializer = false) => {
            if (!node) return;
            if (Array.isArray(node)) {
                for (const n of node) visitNode(n, className, inInitializer);
                return;
            }
            if (typeof node !== 'object') return;

            if (node.type === 'ClassDef') {
                const cls = this.getName(node.name) || "<anon-class>";
                for (const m of (node.methods || [])) {
                    const methodName = this.getName(m.name) || "<anon-method>";
                    visitNode(m.body || [], cls, methodName === "in");
                }
                return;
            }

            // Nested function bodies are independent scopes; do not propagate
            // initializer-return rules from an outer initializer into them.
            if (node.type === 'FunctionDef') {
                visitNode(node.body || [], className, false);
                return;
            }

            if (node.type === 'Return' && inInitializer && node.value) {
                issues.push({
                    className: className || "<unknown-class>",
                    methodName: "in",
                    returnType: node.value.type || typeof node.value
                });
            }

            for (const k of Object.keys(node)) {
                if (k === 'parent' || k === 'moduleScope') continue;
                visitNode(node[k], className, inInitializer);
            }
        };

        visitNode(nodes);
        return issues;
    }

    normalizeReceiverAlias(name) {
        if (name !== "this") return name;

        const localSelf = this.resolveLocal("self");
        if (localSelf !== -1) return "self";

        if (this.functions.length > 1) {
            const up = this.resolveUpvalue(this.functions.length - 2, "self");
            if (up !== -1) return "self";
        }

        return name;
    }

    emitLoad(name) {
        name = this.normalizeReceiverAlias(name);
        // 1. Check local stack first
        let i = this.resolveLocal(name);
        if (i !== -1) { 
            this.emit(OPS.GET_LOCAL); this.emit(i); 
            return;
        } 
        
        // 2. Check upvalues
        let u = -1;
        if (this.functions.length > 1) {
             u = this.resolveUpvalue(this.functions.length - 2, name);
        }
        if (u !== -1) { this.emit(OPS.GET_UPVALUE); this.emit(u); return; }

        // FIX: Implicit Field Read (this.val)
        if (this.inMethod && !this.knownGlobals.has(name)) {
             this.emit(OPS.GET_LOCAL); this.emit(0); // self
             this.emit(OPS.GET_PROP); this.emit(this.addConstant(name));
             return;
        }

        // 3. Fallback to Global
        this.emit(OPS.GET_GLOBAL); this.emit(this.addConstant(name));
    }

    emitStore(name) {
        name = this.normalizeReceiverAlias(name);
        let i = this.resolveLocal(name);
        if (i !== -1) { 
            this.emit(OPS.SET_LOCAL); this.emit(i); 
            return;
        }

        let u = -1;
        if (this.functions.length > 1) {
            u = this.resolveUpvalue(this.functions.length - 2, name);
        }
        
        if (u !== -1) { 
            this.emit(OPS.SET_UPVALUE); this.emit(u); 
        } else {
            if (this.scopeDepth === 0 && !this.inMethod) {
                this.knownGlobals.add(name);
            }
            this.emit(OPS.SET_GLOBAL); 
            this.emit(this.addConstant(name));
        }
    }

    emit(byte) { this.currentFunction().code.push(byte); this.currentFunction().codeLines.push(this.currentLine);}
    emitConstant(val) { this.emit(OPS.CONST); this.emit(this.addConstant(val)); }
    emitJump(op) { this.emit(op); this.emit(0xff); this.emit(0xff); return this.currentFunction().code.length - 2; }
    patchJump(offset) { 
        this.compilerInvariant(Number.isInteger(offset) && offset >= 0, `patchJump: invalid offset ${offset}`);
        this.compilerInvariant(offset + 1 < this.currentFunction().code.length, `patchJump: offset ${offset} out of bounds`);
        const jump = this.currentFunction().code.length - offset - 2;
        this.compilerInvariant(jump >= 0 && jump <= 0xffff, `patchJump: jump distance out of range (${jump})`);
        this.currentFunction().code[offset] = (jump >> 8) & 0xff;
        this.currentFunction().code[offset+1] = jump & 0xff;
    }
    emitLoop(start) { 
        this.emit(OPS.LOOP); 
        const offset = this.currentFunction().code.length - start + 2; 
        this.compilerInvariant(offset >= 0 && offset <= 0xffff, `emitLoop: loop distance out of range (${offset})`);
        this.emit((offset >> 8) & 0xff); this.emit(offset & 0xff); 
    }
    addConstant(val) { this.currentFunction().constants.push(val); return this.currentFunction().constants.length - 1; }
    currentFunction() { return this.functions[this.functions.length - 1]; }
    currentLocals() { return this.locals[this.locals.length - 1]; }
    beginScope() { this.scopeDepth++; }
    endScope() {
        this.compilerInvariant(this.scopeDepth > 0, "endScope: scopeDepth underflow");
        this.scopeDepth--;
        const currentLocals = this.locals[this.locals.length - 1];
        this.compilerInvariant(Array.isArray(currentLocals), "endScope: locals stack missing current frame");
        while (currentLocals.length > 0 && currentLocals[currentLocals.length - 1].depth > this.scopeDepth) {
            const local = currentLocals.pop();
            // Synthetic locals are metadata-only (no stack slot to unwind).
            if (local && local.stackBound !== false) {
                this.emit(OPS.CLOSE_UPVALUE);
            }
        }
    }
    resolveLocal(name) {
        const locals = this.currentLocals();
        for (let i = locals.length - 1; i >= 0; i--) { if (locals[i].name === name) return i; }
        return -1;
    }
    resolveUpvalue(fnIdx, name) {
        if (fnIdx < 0) return -1;
        if (!this.upvalues[fnIdx]) return -1;
        this.compilerInvariant(fnIdx < this.locals.length, `resolveUpvalue: missing locals frame ${fnIdx}`);

        // 1. Check parent's local variables (Standard Closure)
        const parentLocals = this.locals[fnIdx];
        if (parentLocals) {
            for (let i = parentLocals.length - 1; i >= 0; i--) {
                const variable = parentLocals[i];
                if (variable.name === name) {
                    return this.addUpvalue(fnIdx + 1, i, true);
                }
            }
        }
        
        // 2. Grandparent Search (Recursive Chaining)
        // If parent doesn't have it locally, ask the parent to resolve it as an upvalue
        const up = this.resolveUpvalue(fnIdx - 1, name);
        if (up !== -1) {
            // FIX: Middle-man capture. Parent adds it to their upvalues, 
            // then we add it to ours pointing to the parent's upvalue slot.
            return this.addUpvalue(fnIdx + 1, up, false);
        }
        
        return -1;
    }
    addUpvalue(fnIdx, index, isLocal) {
        const upvalues = this.upvalues[fnIdx];
        this.compilerInvariant(Array.isArray(upvalues), `addUpvalue: missing upvalue frame ${fnIdx}`);
        for (let i = 0; i < upvalues.length; i++) { if (upvalues[i].index === index && upvalues[i].isLocal === isLocal) return i; }
        upvalues.push({ index, isLocal });
        return upvalues.length - 1;
    }
}

if (typeof window !== 'undefined') window.Compiler = Compiler;
if (typeof module !== 'undefined') module.exports = Compiler;
