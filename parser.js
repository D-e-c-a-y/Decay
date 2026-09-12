var __dk_window = (typeof globalThis !== 'undefined' && globalThis.window)
    ? globalThis.window
    : ((typeof globalThis !== 'undefined') ? globalThis : {});
const intern = (typeof __dk_window.intern === 'function')
    ? __dk_window.intern.bind(__dk_window)
    : ((str) => String(str));

class Parser {
    constructor(tokens, logger, instanceName = "HOST") { 
        this.tokens = tokens; 
        this.pos = 0; 
        this.logger = logger; 
        this.instanceName = instanceName;
        this.traceEnabled = false;
        this.trace(`Instance '${this.instanceName}' initialized.`);
        this.nestingLevel = 0;
        this.inClassBody = false; 
        this.scopeStack = [new Set()]; 
        this.inNeuralBlock = false;
        this.classNestingStack = [];
        this.warnings = [];
    }

    peek(n = 0) { return this.tokens[this.pos + n] || { type: 'EOF', value: '' }; }
    consume() { return this.tokens[this.pos++] || { type: 'EOF', value: '' }; }
    trace(msg) { if (this.logger && this.traceEnabled) this.logger(`<span style="color:#888; font-size:0.85em">[PARSER:${this.instanceName}] ${msg}</span>`); }
    tag(node) { if (node) node._creator = this.instanceName; node.line = this.peek().line || 1; return node; }
    
    error(msg) {
        const line = this.peek().line || "Unknown";
        throw new Error(`[PARSER ERROR] ${msg} at Line: ${line}`);
    }

    warn(msg) {
        const line = this.peek().line || "Unknown";
        const full = `[PARSER WARN] ${msg} at Line: ${line}`;
        this.warnings.push(full);
        if (this.logger) this.logger(full);
    }

    peekSkipNL(startOffset = 0) {
        let i = startOffset;
        while (this.peek(i).type === 'NL') i++;
        return { token: this.peek(i), offset: i };
    }

    isTerminator(type) {
        let t = this.peek();
        if (t.type === 'EOF') return true;
        if (type === 'HASH') return t.type === 'HASH' || t.value === '#';
        if (type === 'CLASS') {
            return this.isClassTerminatorAt(0);
        }
        return false;
    }

    isClassTerminatorAt(offset = 0) {
        const t = this.peek(offset);
        if (!t) return false;
        return t.type === 'CLASS' || t.type === 'CLASS_SIGIL' || (t.value === '*' && this.peek(offset + 1).value === '*');
    }

    consumeClassTerminator(offset = 0) {
        const t = this.peek(offset);
        if (!t) return false;
        if (t.type === 'CLASS_SIGIL') {
            this.consume();
            return true;
        }
        if (t.value === '*' && this.peek(offset + 1).value === '*') {
            this.consume();
            this.consume();
            return true;
        }
        if (t.type === 'CLASS') {
            this.consume();
            return true;
        }
        return false;
    }

    isClassOpenerAt(offset = 0) {
        const t = this.peek(offset);
        const isValidHeaderShape = (nameTok, afterNameTok) => {
            if (nameTok.type !== 'var') return false;
            // Disambiguate from class terminator followed by normal code:
            // `... class in(flags) ...` should not start a new class.
            if (afterNameTok && afterNameTok.value === '(') return false;
            return true;
        };

        if (t.type === 'CLASS') {
            const lookedName = this.peekSkipNL(offset + 1);
            const nameTok = lookedName.token;
            const afterNameTok = this.peekSkipNL(lookedName.offset + 1).token;
            return isValidHeaderShape(nameTok, afterNameTok);
        }
        if (t.type === 'CLASS_SIGIL' || (t.value === '*' && this.peek(offset + 1).value === '*')) {
            const lookedName = this.peekSkipNL(offset + 1);
            const nameTok = lookedName.token;
            const afterNameTok = this.peekSkipNL(lookedName.offset + 1).token;
            return isValidHeaderShape(nameTok, afterNameTok);
        }
        return false;
    }

    isNestedImplicitAmbiguityCheckEnabled() {
        if (typeof __dk_window === 'undefined') return false;
        const flags = __dk_window.DK_FLAGS || {};
        const parserFlags = flags.parser || {};

        // Prefer explicit strict toggle when provided.
        if (Object.prototype.hasOwnProperty.call(parserFlags, "nestingStrict")) {
            return !!parserFlags.nestingStrict;
        }
        // Backward-compat toggle: allowImplicitNested=false => strict.
        if (Object.prototype.hasOwnProperty.call(parserFlags, "allowImplicitNested")) {
            return !parserFlags.allowImplicitNested;
        }

        if (Object.prototype.hasOwnProperty.call(parserFlags, "nestedImplicitAmbiguityCheck")) {
            return !!parserFlags.nestedImplicitAmbiguityCheck;
        }
        // Backward-compat alias.
        if (Object.prototype.hasOwnProperty.call(flags, "nestingStrict")) {
            return !!flags.nestingStrict;
        }
        // New default: permissive nested mode unless explicitly strict.
        return false;
    }

    isAmbiguousImplicitFatalEnabled() {
        if (typeof __dk_window === 'undefined') return true;
        const flags = __dk_window.DK_FLAGS || {};
        const parserFlags = flags.parser || {};
        // Non-fatal mode for exploratory suites: allow parse to continue.
        if (Object.prototype.hasOwnProperty.call(parserFlags, "allowAmbiguousImplicit")) {
            return !parserFlags.allowAmbiguousImplicit;
        }
        if (Object.prototype.hasOwnProperty.call(flags, "allowAmbiguousImplicit")) {
            return !flags.allowAmbiguousImplicit;
        }
        return true;
    }

    getReservedCallableNames() {
        return new Set([
            'print', 'len', 'str', 'num', 'type', 'clock', 'input', 'alert',
            'push', 'pop', 'shift', 'unshift', 'contains',
            'keys', 'values', 'has', 'remove', 'merge',
            'split', 'join', 'trim', 'upper', 'lower', 'sub', 'match', 'replace', 'match_at',
            'json_parse', 'json_str', 'rand', 'rand_int', 'time', 'date',
            'shuffle', 'reverse', 'buffer', 'char', 'ord',
            'max', 'min', 'abs', 'floor', 'ceil', 'round', 'sqrt', 'pow',
            'trunc', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan2', 'exp', 'log', 'log10', 'log2',
            'clamp', 'lerp', 'sign',
            'clone', 'unique', 'sort', 'splice', 'fill', 'indexOf',
            'map', 'filter', 'forEach', 'reduce', 'some', 'every',
            'b64_enc', 'b64_dec', 'fetch_text', 'sleep',
            'dot_product', 'vec_add', 'vec_sub', 'vec_scale', 'vec_mag', 'vec_norm', 'vec_dist',
            'mat_mul', 'vec_softmax',
            'slice', 'chunk', 'run'
        ]);
    }

    isFunctionDefinition(allowImplicit) {
        const t = this.peek();
        
        if (t.type === 'FN') return true; 

        const entrySig = this.hasEntryFlagSignatureFrom(0);
        if (entrySig) return true;

        const RESERVED_NATIVES = this.getReservedCallableNames();
        if (RESERVED_NATIVES.has(t.value)) return false;
        
        if (t.type === 'var') {
            if (this.peek(1).value !== '(') return false;

            let i = 2; 
            let depth = 1;
            let isCleanSignature = true;
            
            while (depth > 0 && this.peek(i).type !== 'EOF') {
                const tok = this.peek(i);
                if (tok.value === '(') depth++;
                else if (tok.value === ')') depth--;
                else if (depth === 1) {
                     if (tok.type !== 'var' && tok.value !== ',' && tok.type !== 'NL') {
                         isCleanSignature = false;
                         break;
                     }
                }
                i++;
            }
            
            if (!isCleanSignature) return false;

            let afterParens = i;
            while (this.peek(afterParens).type === 'NL') afterParens++;
            const nextToken = this.peek(afterParens);
            const bodyStarterTypes = new Set([
                'var', 'IF', 'FOR', 'WHILE', 'SWITCH', 'TRY', 'USE',
                'RETURN', 'THROW', 'BREAK', 'CONTINUE', 'CLASS'
            ]);
            const looksLikeImplicitBodyStart =
                nextToken.value === '@' ||
                nextToken.value === '{' ||
                nextToken.value === ':' ||
                bodyStarterTypes.has(nextToken.type);

            // Explicit declaration forms are always valid.
            if (nextToken.value === ':' || nextToken.value === '{') return true;

            // If implicit forms are disabled at this parse site, stop here.
            if (!allowImplicit) return false;
            
            let isKnown = false;
            if (this.scopeStack) {
                isKnown = this.scopeStack.some(scope => scope.has(t.value));
            }
            
            const inClassHeaderContext =
                this.inClassBody &&
                this.classNestingStack.length > 0 &&
                this.nestingLevel === this.classNestingStack[this.classNestingStack.length - 1];

            if (isKnown && !inClassHeaderContext) return false;
            if (this.nestingLevel === 0 || inClassHeaderContext) return true;

            // Nested implicit declarations:
            // - strict mode ON: require explicit form and let ambiguity checker decide.
            // - strict mode OFF: preserve legacy permissive behavior.
            if (this.isNestedImplicitAmbiguityCheckEnabled()) return false;
            // In permissive mode, still require a plausible body starter.
            // This prevents call expressions like `f(x) + 1` from being
            // misread as nested function definitions.
            return looksLikeImplicitBodyStart;
        }
        
        return false;
    }

    hasCleanSignatureFrom(offset) {
        if (this.peek(offset).type !== 'var' || this.peek(offset + 1).value !== '(') return null;
        let i = offset + 2;
        let depth = 1;
        while (depth > 0 && this.peek(i).type !== 'EOF') {
            const tok = this.peek(i);
            if (tok.value === '(') depth++;
            else if (tok.value === ')') depth--;
            else if (depth === 1) {
                if (tok.type !== 'var' && tok.value !== ',' && tok.type !== 'NL') return null;
            }
            i++;
        }
        if (depth !== 0) return null;
        return { afterSigOffset: i };
    }

    hasChainedSignatureOnSameLine(afterSigOffset, firstLine) {
        let i = afterSigOffset;
        while (this.peek(i).type === 'NL') i++;
        const next = this.peek(i);
        if (next.type !== 'var') return false;
        if ((next.line || -1) !== (firstLine || -2)) return false;
        return !!this.hasCleanSignatureFrom(i);
    }

    hasEntryFlagSignatureFrom(offset) {
        const nameTok = this.peek(offset);
        if (nameTok.type !== 'var' || nameTok.value !== 'in') return null;
        if (this.nestingLevel !== 0 || this.inClassBody) return null;
        if (this.peek(offset + 1).value !== '(') return null;

        let i = offset + 2;
        while (this.peek(i).type === 'NL') i++;
        if (this.peek(i).value !== '[') return null;

        let depth = 0;
        while (this.peek(i).type !== 'EOF') {
            const tok = this.peek(i);
            if (tok.value === '[') depth++;
            else if (tok.value === ']') {
                depth--;
                if (depth === 0) {
                    i++;
                    break;
                }
            }
            i++;
        }
        if (depth !== 0) return null;
        while (this.peek(i).type === 'NL') i++;
        if (this.peek(i).value !== ')') return null;
        return { afterSigOffset: i + 1 };
    }

    isLikelyImplicitFunctionStart(offset = 0) {
        const sig = this.hasCleanSignatureFrom(offset);
        if (!sig) return false;
        let j = sig.afterSigOffset;
        while (this.peek(j).type === 'NL') j++;
        const next = this.peek(j);
        const bodyStarters = new Set([
            'var', 'IF', 'FOR', 'WHILE', 'SWITCH', 'TRY', 'USE',
            'RETURN', 'THROW', 'BREAK', 'CONTINUE', 'CLASS'
        ]);
        return next.value === '@' || next.value === ':' || next.value === '{' || bodyStarters.has(next.type);
    }

    analyzeTopLevelTail(startOffset) {
        let i = startOffset;
        let depth = 0;
        let hasTopLevelReturn = false;
        let hasTopLevelNonReturnBeforeReturn = false;

        const blockOpeners = new Set(['IF', 'FOR', 'WHILE', 'SWITCH', 'TRY']);
        while (this.peek(i).type !== 'EOF') {
            const tok = this.peek(i);

            if (tok.type === 'NL' || tok.value === ';') {
                i++;
                continue;
            }

            if (tok.type === 'HASH' || tok.value === '#') {
                if (depth === 0) break;
                depth--;
                i++;
                continue;
            }

            if (depth === 0 && (tok.type === 'ELSE' || tok.type === 'ERR' || tok.value === '}')) {
                break;
            }

            if (blockOpeners.has(tok.type)) {
                if (depth === 0 && !hasTopLevelReturn) hasTopLevelNonReturnBeforeReturn = true;
                depth++;
                i++;
                continue;
            }

            if (depth === 0 && (tok.type === 'RETURN' || tok.value === '@')) {
                hasTopLevelReturn = true;
                break;
            }

            if (depth === 0 && !hasTopLevelReturn) {
                hasTopLevelNonReturnBeforeReturn = true;
            }
            i++;
        }

        return {
            hasTopLevelReturn,
            hasTopLevelNonReturnBeforeReturn
        };
    }

    getNestedImplicitSignal() {
        if (this.nestingLevel === 0) return { found: false };
        const inClassHeaderContext =
            this.inClassBody &&
            this.classNestingStack.length > 0 &&
            this.nestingLevel === this.classNestingStack[this.classNestingStack.length - 1];
        if (inClassHeaderContext) return { found: false };

        const sig = this.hasCleanSignatureFrom(0);
        if (!sig) return { found: false };

        const nameTok = this.peek(0);
        const fnName = nameTok && nameTok.type === 'var' ? nameTok.value : "<anonymous>";
        const reserved = this.getReservedCallableNames();
        if (reserved.has(fnName)) return { found: false };
        const isKnownName = this.scopeStack && this.scopeStack.some(scope => scope.has(fnName));
        if (isKnownName) return { found: false };

        let j = sig.afterSigOffset;
        while (this.peek(j).type === 'NL') j++;
        const next = this.peek(j);

        if (next.value === ':' || next.value === '{') {
            return { found: true, name: fnName, explicit: true, ambiguous: false };
        }

        const bodyStarters = new Set([
            'var', 'IF', 'FOR', 'WHILE', 'SWITCH', 'TRY', 'USE', 'CLASS',
            'RETURN', 'THROW', 'BREAK', 'CONTINUE'
        ]);
        const looksLikeBodyStart = bodyStarters.has(next.type) || next.value === '@';
        const tail = this.analyzeTopLevelTail(j);
        const hasTopLevelReturn = !!tail.hasTopLevelReturn;
        const hasTopLevelNonReturnBeforeReturn = !!tail.hasTopLevelNonReturnBeforeReturn;
        const firstLine = nameTok && nameTok.line;
        const chainedSignatureSameLine = this.hasChainedSignatureOnSameLine(sig.afterSigOffset, firstLine);

        return {
            found: looksLikeBodyStart,
            name: fnName,
            explicit: false,
            looksLikeBodyStart,
            hasTopLevelReturn,
            hasTopLevelNonReturnBeforeReturn,
            ambiguous:
                looksLikeBodyStart &&
                (
                    chainedSignatureSameLine ||
                    (hasTopLevelReturn && hasTopLevelNonReturnBeforeReturn && next.type === 'var' && next.line === firstLine)
                )
        };
    }

    parseSwitchBody() {
        const body = [];
        while (this.peek().type === 'NL') this.consume();

        while (this.peek().type !== 'EOF') {
            const loopStartPos = this.pos;
            const t = this.peek();
            
            if (t.type === 'CASE' || t.type === 'DEFAULT' || this.isTerminator('HASH') || t.value === '}') break;
            if (t.type === 'NL' || t.value === ';') { this.consume(); continue; }
            
            const stmt = this.parseStatement();
            if (stmt) body.push(this.tag(stmt));
            else this.consume(); 
            if (this.pos === loopStartPos) {
                this.error(`Parser stalled in switch body near token '${t.value}' (${t.type})`);
            }
        }
        return body;
    }

    parseFunctionDef(isMethod = false) {
        let nameToken = null;
        let first = this.consume(); 
        
        if (first.type === 'FN') {
            // FIX: Only grab the name if the next token isn't '('
            if (this.peek().value !== '(') {
                nameToken = this.consume();
            }
        } else {
            // Implicit method definition
            nameToken = first;
        }

        let name = nameToken ? intern(nameToken.value) : "";
        if (name && name !== "") {
            this.scopeStack[this.scopeStack.length - 1].add(name);
        }

        this.consume(); // '('
        
        let params = [];
        let entryFlagSignature = false;
        while (this.peek().type === 'NL') this.consume();
        if (name === "in" && this.nestingLevel === 0 && this.peek().value === '[') {
            entryFlagSignature = true;
            let depth = 0;
            while (this.peek().type !== 'EOF') {
                const tok = this.consume();
                if (tok.value === '[') depth++;
                else if (tok.value === ']') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            params.push({ type: 'var', value: 'flags' });
        } else if (this.peek().value !== ')') {
            params.push(this.consume());
            while (this.peek().value === ',') { 
                this.consume(); 
                params.push(this.consume()); 
            }
        }
        
        const closeParenToken = this.consume(); // ')'
        
        while (this.peek().type === 'NL') this.consume();
        
        let mode = 'STOP_ON_RETURN';
        
        if (this.peek().value === ':') {
            this.consume();
        } else if (this.peek().value === '{' && this.peek().line === closeParenToken.line) {
            // Disambiguate `{...}` used as the full function body from `{expr}`
            // used as a normal statement (common in minified one-line code).
            const braceStart = this.pos;
            let depth = 0;
            let i = braceStart;
            let matchedEnd = -1;
            while (this.peek(i - this.pos).type !== 'EOF') {
                const tok = this.peek(i - this.pos);
                if (tok.value === '{') depth++;
                else if (tok.value === '}') {
                    depth--;
                    if (depth === 0) { matchedEnd = i; break; }
                }
                i++;
            }

            let looksLikeWholeBody = false;
            if (matchedEnd !== -1) {
                let j = matchedEnd - this.pos + 1;
                while (this.peek(j).type === 'NL' || this.peek(j).value === ';') j++;
                const after = this.peek(j);
                looksLikeWholeBody =
                    after.type === 'EOF' ||
                    after.type === 'HASH' || after.value === '#' ||
                    after.type === 'CLASS' || after.type === 'CLASS_SIGIL' ||
                    after.type === 'ELSE' || after.type === 'ERR';
            }

            if (looksLikeWholeBody) {
                this.consume();
                mode = 'BRACE';
            }
        }

        const body = this.parseBlock(mode, isMethod);
        if (!body._terminatedByReturn) {
            const fnLabel = name && name !== "" ? `'${name}'` : "anonymous function";
            this.error(`Function ${fnLabel} is missing terminating '@'`);
        }
        
        while (this.peek().type === 'NL') this.consume();
        if (this.peek().type === 'HASH' || this.peek().value === '#') this.consume();

        return { type: 'FunctionDef', name, params, body, entryFlagSignature };
    }

    parse() {
        this.nestingLevel = 0; 
        let nodes = [];
        while (this.peek().type !== 'EOF') {
            const loopStartPos = this.pos;
            let t = this.peek();
            if (t.type === 'NL' || t.value === ';') { this.consume(); continue; }
            
            if (this.isClassOpenerAt(0)) {
                nodes.push(this.tag(this.parseClass()));
                continue;
            }

            if (this.isFunctionDefinition(true)) {
                this.trace(`Found Definition: ${this.peek().value}`);
                const node = this.tag(this.parseFunctionDef(false));
                nodes.push(node);
            } else {
                this.trace(`Found Statement: ${t.value}`);
                const node = this.tag(this.parseStatement());
                nodes.push(node);
                const nType = node && node.type ? node.type : "<unknown>";
            }
            if (this.pos === loopStartPos) {
                this.error(`Parser stalled at top-level near token '${t.value}' (${t.type})`);
            }
        }
        return nodes;
    }

    parseArrayLiteral(isExplicitVector) {
        this.consume(); 

        if (this.peek().value === ':' && this.peek(1).value === ']') {
            this.consume(); this.consume();
            return this.tag({ type: 'MapLiteral', entries: [] });
        }

        let elements = [];
        while (this.peek().value !== ']' && this.peek().type !== 'EOF') {
            if (this.peek().type === 'NL') { this.consume(); continue; }
            
            let check = this.peekSkipNL(1);
            if (check.token.value === ':') {
                let k = intern(this.consume().value); this.consume();
                elements.push(this.tag({ type: 'MapEntry', key: k, value: this.parseExpr(0) }));
            } else if (this.peek().value === '^' && this.peek(1).type === 'var' && this.peek(2).value === ':') {
                this.consume(); let k = intern(this.consume().value); this.consume();
                elements.push(this.tag({ type: 'MapEntry', key: k, value: this.parseExpr(0) }));
            } else {
                let beforePos = this.pos;
                elements.push(this.parseExpr(0));
                
                if (this.pos === beforePos) {
                    this.consume(); 
                }
            }
            
            if (this.peek().value === ',') this.consume();
        }

        if (this.peek().value === ']') this.consume();
        
        return this.tag({ 
            type: 'ArrayLiteral', 
            elements, 
            isVector: isExplicitVector || this.inNeuralBlock 
        });
    }

      parseClass() {
          let t = this.consume(); 
          if (t.value === '*' && this.peek(1).value === '*') this.consume(); 
  
          let nameToken = this.consume();
          if (nameToken.type !== 'var') {
              this.error("Invalid class declaration: missing class name");
          }
          let name = intern(nameToken.value);
        let parent = null;
        if (this.peek().value === ':') { 
            this.consume(); 
            parent = intern(this.consume().value); 
        }
        
        while (this.peek().type === 'NL') this.consume();
        
        let usesBrace = false;
        if (this.peek().value === '{') {
            this.consume();
            usesBrace = true;
        }

        const prevInClass = this.inClassBody;
        this.inClassBody = true;
        this.classNestingStack.push(this.nestingLevel);
        this.scopeStack.push(new Set()); 

          let methods = [];
          let terminated = false;
          while (this.peek().type !== 'EOF') {
              let next = this.peek();
              if (next.type === 'NL' || next.value === ';') { this.consume(); continue; }
              
              if (usesBrace && next.value === '}') {
                  this.consume();
                  terminated = true;
                  break;
              }
              if (this.isClassTerminatorAt(0)) {
                  this.consumeClassTerminator(0);
                  terminated = true;
                  break;
              }
  
              if (this.isFunctionDefinition(true)) {
                  methods.push(this.tag(this.parseFunctionDef(true)));
              } else {
                  this.consume(); 
              }
          }
          if (!terminated && this.peek().type === 'EOF') {
              const warnUnterminatedClass =
                  (typeof __dk_window !== 'undefined') &&
                  !!__dk_window.DK_FLAGS &&
                  !!__dk_window.DK_FLAGS.parser &&
                  !!__dk_window.DK_FLAGS.parser.warnUnterminatedClass;
              if (warnUnterminatedClass) {
                  const msg = `[PARSER] class '${name}' reached EOF without terminator at line ${this.peek().line || "?"}`;
                  if (this.logger) this.logger(msg);
                  else if (typeof console !== 'undefined' && console.log) console.log(msg);
              }
          }
          
          this.inClassBody = prevInClass;
          if (this.classNestingStack.length > 0) this.classNestingStack.pop();
          this.scopeStack.pop(); 
          
        return { type: 'ClassDef', name, parent, methods };
    }

    parseBlock(mode, isMethod = false) {
        this.nestingLevel++; 
        this.scopeStack.push(new Set()); 
        const prevInClass = this.inClassBody;

        let body = [];
        let terminatedByReturn = false;
        while (this.peek().type !== 'EOF') {
            const loopStartPos = this.pos;
            let t = this.peek();
            if (t.type === 'NL' || t.value === ';') { this.consume(); continue; }
            const strictNestedMode =
                this.isNestedImplicitAmbiguityCheckEnabled() && this.nestingLevel > 0;
            const allowImplicitDefsHere = !strictNestedMode;
            
            // Boundary Logic
            if (mode === 'BRACE' && t.value === '}') break;
            if (mode === 'HASH' && this.isTerminator('HASH')) break; 

            const nestedSig = this.getNestedImplicitSignal();
            if (nestedSig.found && !nestedSig.explicit) {
                if (nestedSig.ambiguous) {
                    const msg =
                        `Ambiguous nested implicit declaration '${nestedSig.name}'. Use an explicit form: \`name(args): ... @\`, \`function name(args) ... @\`, or \`name = fn(args) ... @\``;
                    if (this.isAmbiguousImplicitFatalEnabled()) {
                        this.error(msg);
                    } else {
                        this.warn(msg);
                    }
                }
                if (strictNestedMode) {
                    this.error(
                        `Nested function declaration '${nestedSig.name}' must be explicit. Use \`name(args): ... @\`, \`function name(args) ... @\`, or \`name = fn(args) ... @\``
                    );
                }
            }

            if (this.isFunctionDefinition(allowImplicitDefsHere)) { 
                 body.push(this.tag(this.parseFunctionDef(false)));
                 continue;
            }

            if (this.isClassOpenerAt(0)) {
                body.push(this.tag(this.parseClass()));
                continue;
            }

            if (t.type === 'ELSE' || t.type === 'ERR') break; 
            
            if (t.type === 'RETURN' || t.value === '@') {
                this.consume(); 
                let val = null;
                const boundaries = ['NL', 'EOF', 'HASH', 'ERR', 'ELSE', ';', 'RETURN', 'CLASS', 'CLASS_SIGIL', 'IF', 'FOR', 'WHILE', 'TRY', 'USE', 'SWITCH', 'CASE', 'DEFAULT', 'BREAK', 'CONTINUE', 'THROW', '}'];
                let nextT = this.peek();

                if (
                    !boundaries.includes(nextT.type) &&
                    nextT.value !== '@' &&
                    nextT.value !== '#' &&
                    !this.isFunctionDefinition(allowImplicitDefsHere)
                ) {
                     val = this.parseExpr(0);
                }
                
                body.push(this.tag({ type: 'Return', value: val }));
                if (mode === 'STOP_ON_RETURN') {
                    terminatedByReturn = true;
                    break;
                }
                continue;
            }
            
            body.push(this.tag(this.parseStatement()));
            
            if (this.pos === loopStartPos) {
                this.error(`Parser stalled in block near token '${t.value}' (${t.type})`);
            }
        }
        
        if (mode === 'HASH' && this.isTerminator('HASH')) this.consume();
        if (mode === 'BRACE' && this.peek().value === '}') this.consume();
        
        this.inClassBody = prevInClass;
        this.nestingLevel--; 
        this.scopeStack.pop(); 
        body._terminatedByReturn = terminatedByReturn;
        return body;
    }

    parseNeuralBlock() {
        this.consume(); 
        
        let netName = null;
        let pType = this.peek().type;
        let pVal = this.peek().value;
        const pValLower = typeof pVal === 'string' ? pVal.toLowerCase() : pVal;
        
        if ((pType === 'var' || pType === 'ANY' || pType === 'BRAIN') && pValLower !== 'with' && pValLower !== 'limit') {
            netName = intern(this.consume().value);
        }

        const prevNeuralMode = this.inNeuralBlock;
        this.inNeuralBlock = true;

        let contract = null;
        let terrain = [];
        let withExpr = null;
        let limit = 0;
        let cases = [];

        while (this.peek().type === 'NL') this.consume();
        let usesBrace = false;
        if (this.peek().value === '{') {
            this.consume();
            usesBrace = true;
        }

        if (this.peek().value === '[' || this.peek().type === 'VEC_START') {
            contract = this.parseBase();
        }

        while (this.peek().type !== 'EOF') {
            const loopStartPos = this.pos;
            const t = this.peek();
            
            if (usesBrace && t.value === '}') {
                this.consume();
                break;
            }
            if (!usesBrace && (t.type === 'HASH' || t.value === '#')) {
                this.consume();
                break;
            }

            const tValLower = typeof t.value === 'string' ? t.value.toLowerCase() : t.value;
            
            if (t.type === 'NL' || t.value === ';') { 
                this.consume(); 
                continue; 
            }

            if (tValLower === 'with') {
                this.consume();
                withExpr = this.parseExpr(0);
            }
            else if (tValLower === 'limit') {
                this.consume();
                limit = Number(this.consume().value);
            }
            else if (t.value === '[' || t.type === 'VEC_START') {
                const startLine = t.line;
                const arrExpr = this.parseBase();
                const next = this.peek();
                const nextValLower = typeof next.value === 'string' ? next.value.toLowerCase() : next.value;
                
                const isLabelToken = (next.type === 'var' || next.type === 'str' || next.type === 'num' || next.type === 'ANY');
                const isControlToken = (
                    next.type === 'CASE' || next.type === 'HASH' || next.value === '#' || next.value === '}' || 
                    nextValLower === 'fallback' || nextValLower === 'with' || nextValLower === 'limit'
                );
                
                if (isLabelToken && !isControlToken && next.line === startLine) {
                    const labelTok = this.consume();
                    terrain.push({ weights: arrExpr, label: intern(labelTok.value) });
                } else if (contract == null) {
                    contract = arrExpr;
                } else {
                    terrain.push({ weights: arrExpr, label: null }); 
                }
            }
            else if ((t.type === 'var' || t.type === 'ANY') && (this.peek(1).value === '[' || this.peek(1).type === 'VEC_START')) {
                const labelTok = this.consume();
                const weightsExpr = this.parseBase();
                terrain.push({ weights: weightsExpr, label: intern(labelTok.value) });
            }
            else if (t.type === 'CASE' || tValLower === 'fallback') {
                const consumed = this.consume().value;
                const isFallback = typeof consumed === 'string' && consumed.toLowerCase() === 'fallback';
                const label = isFallback ? 'fallback' : intern(this.consume().value);
                const action = this.parseExpr(0);
                
                if (!isFallback && action?.type === 'ArrayLiteral' && action.isVector) {
                    terrain.push({ weights: action, label });
                } else {
                    cases.push({ label, action });
                }
            } else {
                // FIX: If we see unrelated code (like 'assert'), the implicit block is over! Break out.
                if (!usesBrace) break;
                this.consume();
            }
            
            if (this.pos === loopStartPos) {
                this.error(`Parser stalled in neural block near token '${t.value}' (${t.type})`);
            }
        }
        
        this.inNeuralBlock = prevNeuralMode;
        if (!contract && terrain.length > 0 && !terrain.some(r => r.weights && r.weights.elements && r.weights.elements.length > 0)) {
            this.warn("Neural block has terrain rows but no input shape contract array.");
        }
        return this.tag({ type: 'NeuralDef', name: netName, contract, terrain, withExpr, limit, cases });
    }

    parseBrainBlock() {
        this.consume(); 
        let brainName = null;
        if (this.peek().type === 'var' || this.peek().type === 'NEURAL') {
            const v = String(this.peek().value || '').toLowerCase();
            const reservedStarters = new Set([
                'use', 'config', 'with', 'entry', 'exit', 'limit', 'stop',
                'sample', 'identity', 'memory', 'stream', 'callback', 'prompt'
            ]);
            if (!reservedStarters.has(v)) {
                brainName = intern(this.consume().value);
            }
        }

        while (this.peek().type === 'NL') this.consume();
        let usesBrace = false;
        if (this.peek().value === '{') {
            this.consume();
            usesBrace = true;
        }

        let uses = [];
        let configMap = null;
        let legend = null;
        let topology = [];
        let entrySize = null;
        let exitSize = null;
        let limit = null;
        let stopPattern = null;
        let sampleMap = null;
        let identityStr = null;
        let memoryState = false;
        let streamState = false;
        let callbackFn = null;
        let promptExpr = null;

        while (this.peek().type !== 'EOF') {
            const t = this.peek();
            
            if (usesBrace && t.value === '}') {
                this.consume();
                break;
            }
            if (!usesBrace && (t.type === 'HASH' || t.value === '#')) {
                this.consume();
                break;
            }

            const loopStartPos = this.pos;
            if (t.type === 'NL' || t.value === ';') { this.consume(); continue; }

            if (t.type === 'USE') {
                this.consume(); 
                if (this.peek().type === 'var') {
                    const label = this.consume().value; 
                    const path = this.consume().value;  
                    uses.push({ label, path });
                } else {
                    const path = this.consume().value;
                    uses.push({ label: 'auto', path });
                }
            }
            else if (t.type === 'var') {
                const val = String(t.value || '').toLowerCase();
                if (val === 'config') {
                    this.consume();
                    configMap = this.parseBase(); 
                } else if (val === 'with') {
                    this.consume();
                    legend = this.parseBase();
                } else if (val === 'entry') {
                    this.consume();
                    if (this.peek().value === ',') {
                        this.consume(); 
                        if (String(this.peek().value || '').toLowerCase() === 'exit') {
                            this.consume(); 
                            entrySize = Number(this.consume().value);
                            exitSize = entrySize;
                        }
                    } else {
                        entrySize = Number(this.consume().value);
                    }
                } else if (val === 'exit') {
                    this.consume();
                    exitSize = Number(this.consume().value);
                } else if (val === 'limit') {
                    this.consume();
                    limit = Number(this.consume().value);
                } else if (val === 'stop') {
                    this.consume();
                    stopPattern = this.parseBase(); 
                } else if (val === 'sample') {
                    this.consume();
                    sampleMap = this.parseBase(); 
                } else if (val === 'identity') {
                    this.consume();
                    identityStr = this.parseExpr(0);
                } else if (val === 'memory') {
                    this.consume();
                    memoryState = this.consume().value === 'true';
                } else if (val === 'stream') {
                    this.consume();
                    streamState = this.consume().value === 'true';
                } else if (val === 'callback') {
                    this.consume();
                    callbackFn = this.parseExpr(0); 
                } else if (val === 'prompt') {
                    this.consume();
                    promptExpr = this.parseExpr(0);
                } else {
                    // FIX: Unrecognized var. If not using braces, the implicit block is over!
                    if (!usesBrace) break;
                    this.consume(); 
                }
            }
            else if (t.value === '[' || t.type === 'VEC_START') {
                topology.push(this.parseBase());
            }
            else {
                // FIX: Unrecognized token. If not using braces, the implicit block is over!
                if (!usesBrace) break;
                this.consume();
            }
            if (this.pos === loopStartPos) {
                this.error(`Parser stalled in brain block near token '${t.value}' (${t.type})`);
            }
        }

        return this.tag({ 
            type: 'BrainDef', 
            name: brainName, 
            uses, configMap, legend, topology, 
            entrySize, exitSize, limit, stopPattern, 
            sampleMap, identityStr, memoryState, 
            streamState, callbackFn, promptExpr 
        });
    }

    parseSolverBlock() {
        this.consume();
        let solverName = null;
        if (this.peek().type === 'var') {
            const v = String(this.peek().value || '').toLowerCase();
            const reservedStarters = new Set(['rules', 'prefer', 'optimize', 'mode', 'limit', 'timeout']);
            if (!reservedStarters.has(v)) {
                solverName = intern(this.consume().value);
            }
        }

        while (this.peek().type === 'NL') this.consume();
        let usesBrace = false;
        if (this.peek().value === '{') {
            this.consume();
            usesBrace = true;
        }

        let domain = null;
        let rules = [];
        let prefer = [];
        let optimize = [];
        let mode = null;
        let limit = null;
        let timeout = null;

        while (this.peek().type !== 'EOF') {
            const t = this.peek();
            if (usesBrace && t.value === '}') {
                this.consume();
                break;
            }
            if (!usesBrace && (t.type === 'HASH' || t.value === '#')) {
                this.consume();
                break;
            }

            const loopStartPos = this.pos;
            if (t.type === 'NL' || t.value === ';') { this.consume(); continue; }

            if ((t.value === '[') && domain == null) {
                domain = this.parseBase();
            }
            else if (t.type === 'var') {
                const val = String(t.value || '').toLowerCase();
                if (val === 'rules') {
                    this.consume();
                    const arr = this.parseBase();
                    rules = (arr && arr.type === 'ArrayLiteral') ? arr.elements.slice() : [];
                } else if (val === 'prefer') {
                    this.consume();
                    const arr = this.parseBase();
                    prefer = (arr && arr.type === 'ArrayLiteral') ? arr.elements.slice() : [];
                } else if (val === 'optimize') {
                    this.consume();
                    const arr = this.parseBase();
                    optimize = (arr && arr.type === 'ArrayLiteral') ? arr.elements.slice() : [];
                } else if (val === 'mode') {
                    this.consume();
                    mode = this.parseExpr(0);
                } else if (val === 'limit') {
                    this.consume();
                    limit = this.parseExpr(0);
                } else if (val === 'timeout') {
                    this.consume();
                    timeout = this.parseExpr(0);
                } else {
                    if (!usesBrace) break;
                    this.consume();
                }
            }
            else {
                if (!usesBrace) break;
                this.consume();
            }

            if (this.pos === loopStartPos) {
                this.error(`Parser stalled in solver block near token '${t.value}' (${t.type})`);
            }
        }

        return this.tag({
            type: 'SolverDef',
            name: solverName,
            domain,
            rules,
            prefer,
            optimize,
            mode,
            limit,
            timeout
        });
    }

    parseStatement() {
        let t = this.peek();
        if (t.type === 'NL') { this.consume(); return this.parseStatement(); }

        if (t.type === 'var' && this.peek(1).type === 'VEC_START') {
            const left = this.tag({ type: 'Var', name: intern(this.consume().value) });
            const right = this.parseExpr(0); 
            return this.tag({ type: 'Stmt', value: { type: 'Assign', op: '=', left, right } });
        }
        
        // FIX 1: Catch array-style Destructuring [x, y] = getPoint()
        if (t.value === '[') {
            let isDestruct = false;
            let i = 1;
            while(this.peek(i).type !== 'EOF' && this.peek(i).value !== ']') i++;
            if (this.peek(i).value === ']' && this.peek(i+1).value === '=') isDestruct = true;
            
            if (isDestruct) {
                this.consume(); // '['
                let names = [];
                while (this.peek().value !== ']') {
                    let next = this.consume();
                    if (next.type === 'NL' || next.value === ',') continue;
                    names.push(intern(next.value));
                }
                this.consume(); // ']'
                this.consume(); // '='
                return this.tag({ type: 'Stmt', value: { type: 'Destructure', names, right: this.parseExpr(0) } });
            }
        }

        // Keep legacy Destructure fallback
        if (t.type === 'var' && this.peek(1).value === ',') {
            let names = []; names.push(intern(this.consume().value));
            while(this.peek().value === ',') { this.consume(); names.push(intern(this.consume().value)); }
            if (this.peek().value === '=') { this.consume(); return this.tag({ type: 'Stmt', value: { type: 'Destructure', names, right: this.parseExpr(0) } }); }
        }

        if (t.type === 'SWITCH') {
            this.consume(); 
            const test = this.parseExpr(0);
            
            this.nestingLevel++;
            const cases = [];
            let defaultBody = null;
            
            while (!this.isTerminator('HASH') && this.peek().value !== '}') {
                let token = this.peek();
                
                if (token.type === 'NL') { this.consume(); continue; }
                
                if (token.type === 'CASE') {
                    this.consume(); 
                    const val = this.parseExpr(0);
                    const body = this.parseSwitchBody(); 
                    cases.push(this.tag({ type: 'Case', value: val, body }));
                } 
                else if (token.type === 'DEFAULT') {
                    this.consume(); 
                    defaultBody = this.parseSwitchBody();
                } 
                else {
                     this.consume();
                }
            }
            if (this.isTerminator('HASH') || this.peek().value === '}') this.consume(); 
            this.nestingLevel--;
            
            return this.tag({ type: 'Switch', test, cases, defaultBody });
        }

        if (t.value === 'print') { this.consume(); return this.tag({ type: 'Stmt', value: { type: 'Call', name: intern('print'), args: [this.parseExpr(0)] } }); }
        
        if (t.type === 'IF') return this.tag({ type: 'If', cond: (this.consume(), this.parseExpr(0)), body: this.parseBlock('HASH'), elseBody: this.peek().type === 'ELSE' ? (this.consume(), this.parseBlock('HASH')) : null });
        
        if (t.type === 'FOR' || t.type === 'WHILE') {
            this.consume();
            let isRange = false;
            // FIX 2: Lookahead 5 tokens so it can actually find '..' in `for i = 1..5`
            for(let i=0; i<5; i++) { if(this.peek(i).type === 'range' || this.peek(i).value === '..') isRange = true; }
            
            if (this.peek().type === 'var' && isRange) {
                let varName = intern(this.consume().value);
                if (this.peek().value === '=') this.consume(); 
                let start = this.parseExpr(0);
                this.consume(); 
                let end = this.parseExpr(0);
                let step = null;
                if (this.peek().type === 'var' && this.peek().value === varName) {
                    let next = this.peek(1);
                    if (next.value === '+=' || next.value === '-=') {
                        let v = this.consume(); let op = this.consume().value; let val = this.parseExpr(0);
                        step = this.tag({ type: 'Assign', op, left: { type:'Var', name:intern(v.value) }, right: val });
                    }
                }
                return this.tag({ type: 'For', isRange: true, varName, start, end, step, body: this.parseBlock('HASH') });
            }
            let init = this.parseExpr(0);
            if (init.type === 'Assign') {
                 let cond = this.parseExpr(0);
                 let step = this.parseExpr(0);
                 return this.tag({ type: 'For', isRange: false, init, cond, step, body: this.parseBlock('HASH') });
            }
            return this.tag({ type: 'For', isRange: false, cond: init, body: this.parseBlock('HASH') });
        }
        
        if (t.type === 'BREAK') { 
            this.consume(); 
            return this.tag({ type: 'Break' }); 
        }
        if (t.type === 'CONTINUE') { 
            this.consume(); 
            return this.tag({ type: 'Continue' }); 
        }

        if (t.type === 'USE') {
            this.consume(); let path = "", alias = null;
            if (this.peek(0).type === 'var' && this.peek(1).value === '=') { alias = intern(this.consume().value); this.consume(); }
            if (this.peek().type === 'str') path = this.consume().value;
            else { path = this.consume().value; while (this.peek().value === '/') { this.consume(); path += '/' + this.consume().value; } }
            if (!alias && this.peek().type === 'AS') { this.consume(); alias = intern(this.consume().value); }
            return this.tag({ type: 'Use', path, alias });
        }

        if (t.type === 'var' && this.peek(1).value === ',') {
            let names = []; names.push(intern(this.consume().value));
            while(this.peek().value === ',') { this.consume(); names.push(intern(this.consume().value)); }
            if (this.peek().value === '=') { this.consume(); return this.tag({ type: 'Stmt', value: { type: 'Destructure', names, right: this.parseExpr(0) } }); }
        }

        if (t.type === 'THROW') { this.consume(); return this.tag({ type: 'Throw', expr: this.parseExpr(0) }); }
        
        if (t.type === 'TRY') {
            this.consume(); let tryBody = this.parseBlock('HASH'), catchBody = [], errVar = null;
            if (this.peek().type === 'ERR') { 
                this.consume(); 
                if (this.peek().type === 'var') errVar = intern(this.consume().value); 
                catchBody = this.parseBlock('HASH'); 
            }
            return this.tag({ type: 'Try', tryBody, catchBody, errVar });
        }
        if (t.type === 'CASE') {
            this.error("`case` used outside `switch`");
        }
        if (t.type === 'DEFAULT') {
            this.error("`default` used outside `switch`");
        }
        const expr = this.parseExpr(0);
        if (expr === null) {
            this.consume();
        }
        return this.tag({ type: 'Stmt', value: expr });
    }

    parseExpr(minPrec) {
        while (this.peek().type === 'NL') this.consume();
        let left = this.parsePrimary();
        
        while (true) {
            let t = this.peek();
            
            const starters = [
                'IF', 'FOR', 'SWITCH', 'TRY', 'CLASS', 'FN',
                'RETURN', 'BREAK', 'CONTINUE', 'USE', 'THROW',
                'ELSE', 'ERR', 'CASE', 'DEFAULT', 'HASH'
            ];
            if (starters.includes(t.type)) break;

            if (t.type !== 'str' && (t.value === '=' || t.value === '+=' || t.value === '-=')) { 
                if (!left) {
                    this.error(`Invalid assignment target before '${t.value}'`);
                }
                let op = this.consume().value; 
                left = this.tag({ type: 'Assign', op, left, right: this.parseExpr(0) }); 
                continue; 
            }

            const p = { 
                'or':1, '||':1, 'and':2, '&&':2, '==':3, '!=':3, 
                '<':4, '>':4, '<=':4, '>=':4, '+':5, '-':5, 
                '*':6, '/':6, '%':6, '&':7, '|':7, '<<':8, '>>':8 
            };
            
            if (t.type === 'str') break;
            
            let prec = p[t.value] || 0; 
            if (prec === 0 || prec < minPrec) break;
            
            this.consume(); 
            left = this.tag({ type: 'Binary', op: t.value, left, right: this.parseExpr(prec + 1) });
        }
        return left;
    }

    parsePrimary() {
        let expr = this.parseBase();
        while (true) {
            let t = this.peek();

            if (t.type === 'NL' || t.type === 'EOF') break;

            // AI block expressions are complete by shape (keyword clauses + '#').
            // In minified single-line code, do not let trailing postfix syntax
            // accidentally chain onto a completed block expression.
            if (expr && (expr.type === 'BrainDef' || expr.type === 'NeuralDef' || expr.type === 'SolverDef')) {
                break;
            }

            if (this.pos > 0) {
                 const prev = this.tokens[this.pos - 1];
                 if (t.line > prev.line) break;
            }

            const isStatementStart = 
                t.type === 'var' || t.type === 'FN' || t.type === 'IF' || t.type === 'FOR' ||
                t.type === 'RETURN' || t.type === 'WHILE' || t.type === 'TRY' ||
                t.type === 'THROW' || t.type === 'CLASS' || t.type === 'USE' ||
                t.type === 'SWITCH' || t.type === 'BREAK' || t.type === 'CONTINUE' ||
                t.type === 'ELSE' || t.type === 'ERR' || t.type === 'CASE' ||
                t.type === 'DEFAULT' || t.type === 'HASH' || t.type === 'NL';

            if (isStatementStart) break; 

            if (t.type !== 'str' && t.value === '[') {
                const prevTok = this.tokens[this.pos - 1];
                const hasGap = prevTok &&
                    typeof prevTok.end === 'number' &&
                    typeof t.start === 'number' &&
                    t.start > prevTok.end;
                if (hasGap) break;

                this.consume();

                if (this.peek().value === ']' && this.peek(1).value === '(') {
                    this.consume();
                    this.consume();
                    let b = this.parseExpr(0);
                    if (this.peek().value !== ')') this.error("Expected ')' after rebase base argument");
                    this.consume();
                    expr = this.tag({ type: 'Rebase', target: expr, baseArg: b });
                    continue;
                }

                let idx = this.parseExpr(0);
                if (this.peek().value === ':') {
                    this.consume();
                    let end = this.parseExpr(0);
                    if (this.peek().value !== ']') this.error("Expected ']' after slice expression");
                    this.consume();
                    expr = this.tag({ type: 'Slice', target: expr, start: idx, end: end });
                    continue;
                }

                if (this.peek().value !== ']') this.error("Expected ']' after index expression");
                this.consume();

                if (this.peek().value === '(') {
                    this.consume();
                    let baseArg = this.parseExpr(0);
                    if (this.peek().value !== ')') this.error("Expected ')' after rebased index base argument");
                    this.consume();
                    expr = this.tag({ type: 'IndexAtBase', target: expr, index: idx, baseArg: baseArg });
                } else {
                    expr = this.tag({ type: 'Index', target: expr, index: idx });
                }
                continue;
            }
            
            else if (t.type !== 'str' && t.value === '.') {
                this.consume(); 
                let prop = intern(this.consume().value);
                const UFCS_TOOLS = new Set([
                    'split', 'join', 'upper', 'lower', 'trim', 
                    'len', 'push', 'pop', 'replace', 'slice',
                    'indexOf', 'startsWith', 'endsWith', 'repeat', 'padStart', 'padEnd',
                    'splice', 'fill', 'map', 'filter', 'forEach',
                    'reduce', 'some', 'every', 'train',
                    'dot_product', 'vec_add', 'vec_sub', 'vec_scale', 'vec_mag', 'vec_norm', 'vec_dist',
                    'mat_mul', 'vec_softmax',
                    'chunk', 'encode', 'pack'
                ]);

                if (this.peek().value === '(') {
                    this.consume(); 
                    let args = [];
                    const isTool = UFCS_TOOLS.has(prop);
                    if (isTool) args.push(expr); 
                    if (this.peek().value !== ')') {
                        const firstArgPos = this.pos;
                        args.push(this.parseExpr(0));
                        if (this.pos === firstArgPos) this.consume();
                        while (this.peek().value === ',') { 
                            this.consume(); 
                            const argPos = this.pos;
                            args.push(this.parseExpr(0));
                            if (this.pos === argPos) this.consume();
                        } 
                    } 
                    this.consume(); 
                    if (isTool) {
                        expr = this.tag({ type: 'Call', name: prop, args, callee: { type: 'Var', name: prop } });
                    } else {
                        expr = this.tag({ type: 'Call', name: null, args, callee: { type: 'Dot', target: expr, prop } });
                    }
                } else { 
                    expr = this.tag({ type: 'Dot', target: expr, prop }); 
                }
            } 
            
            else if (t.type !== 'str' && t.value === '(') {
                this.consume(); 
                let args = []; 
                
                let callName = null;
                if (expr) {
                    if (expr.type === 'Var') callName = expr.name;
                    else if (expr.type === 'GetProp') callName = expr.prop;
                    else if (expr.name) callName = expr.name;
                }

                const sensoryTools = ['slice', 'split', 'chunk', '__builtin_slice', '__builtin_split', '__builtin_chunk', 'tokenize', '__builtin_tokenize'];
                const isRestructure = expr && expr.type === 'Call' && sensoryTools.includes(expr.name);

                if (isRestructure) {
                    if (this.peek().value !== ')') {
                        let sigils = [];
                        while (this.peek().value !== ')' && this.peek().type !== 'EOF') {
                            if (this.peek().type === 'NL') { this.consume(); continue; }
                            sigils.push(this.consume().value);
                        }
                        args.push(this.tag({ type: 'Literal', value: sigils.join(' ') }));
                    }
                } else {
                    while (this.peek().value !== ')' && this.peek().type !== 'EOF') {
                        if (this.peek().type === 'NL') { this.consume(); continue; }
                        const argPos = this.pos;
                        args.push(this.parseExpr(0));
                        if (this.pos === argPos) this.consume();
                        if (this.peek().value === ',') this.consume();
                    }
                }
                this.consume(); 
                
                expr = this.tag({ type: 'Call', name: isRestructure ? null : callName, args, callee: expr });
            } else break;
        } 

        return expr;
    }
    
    parseBase() {
        const t = this.peek();

        if (t.type === 'NEURAL') {
            let nextTok = this.peek(1);
            // If followed by syntax that implies a variable, treat as a variable
            if (nextTok.value === '=' || nextTok.value === '.' || nextTok.value === '(' || nextTok.value === ',' || nextTok.value === ')' || nextTok.value === '}') {
                this.consume();
                return this.tag({ type: 'Var', name: intern(t.value) });
            }
            let skipNL = this.peekSkipNL(1).token;
            if (skipNL.value === '[' || skipNL.type === 'VEC_START') {
                return this.parseNeuralBlock();
            }
            // If the next line starts with a variable, ensure it's actually a neural keyword
            if (skipNL.type === 'var' && skipNL.line > t.line) {
                let val = String(skipNL.value).toLowerCase();
                if (val !== 'with' && val !== 'limit' && skipNL.type !== 'CASE' && val !== 'fallback') {
                    this.consume();
                    return this.tag({ type: 'Var', name: intern(t.value) });
                }
            }
            return this.parseNeuralBlock();
        }

        if (t.type === 'BRAIN') {
            let nextTok = this.peek(1);
            // If followed by syntax that implies a variable, treat as a variable
            if (nextTok.value === '=' || nextTok.value === '.' || nextTok.value === '(' || nextTok.value === ',' || nextTok.value === ')' || nextTok.value === '}') {
                this.consume();
                return this.tag({ type: 'Var', name: intern(t.value) });
            }
            let skipNL = this.peekSkipNL(1).token;
            if (skipNL.value === '[' || skipNL.type === 'VEC_START') {
                return this.parseBrainBlock();
            }
            // If the next line starts with a variable, ensure it's actually a brain keyword
            if (skipNL.type === 'var' && skipNL.line > t.line) {
                const brainProps = new Set(['use', 'config', 'with', 'entry', 'exit', 'limit', 'stop', 'sample', 'identity', 'memory', 'stream', 'callback', 'prompt']);
                if (!brainProps.has(String(skipNL.value).toLowerCase())) {
                    this.consume();
                    return this.tag({ type: 'Var', name: intern(t.value) });
                }
            }
            return this.parseBrainBlock();
        }

        if (t.type === 'SOLVER') {
            let nextTok = this.peek(1);
            if (nextTok.value === '=' || nextTok.value === '.' || nextTok.value === '(' || nextTok.value === ',' || nextTok.value === ')' || nextTok.value === '}') {
                this.consume();
                return this.tag({ type: 'Var', name: intern(t.value) });
            }
            let skipNL = this.peekSkipNL(1).token;
            if (skipNL.value === '[') {
                return this.parseSolverBlock();
            }
            if (skipNL.type === 'var' && skipNL.line > t.line) {
                const solverProps = new Set(['rules', 'prefer', 'optimize', 'mode', 'limit', 'timeout']);
                if (!solverProps.has(String(skipNL.value).toLowerCase())) {
                    this.consume();
                    return this.tag({ type: 'Var', name: intern(t.value) });
                }
            }
            return this.parseSolverBlock();
        }

        if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
            const op = this.consume().value;
            const right = this.parseBase();
            if (op === '+') return right;
            return this.tag({ 
                type: 'Binary', 
                op: '-', 
                left: { type: 'Literal', value: 0 }, 
                right: right 
            });
        }

        if (t.type === 'num') {
            return this.tag({ type: 'Literal', value: Number(this.consume().value) });
        }

        if (t.type === 'str') {
            const val = this.consume().value;
            if (val.includes('{') && val.includes('}')) {
                let parts = val.split(/({[^}]+})/g);
                let root = null;
                for (let p of parts) {
                    let node = null;
                    if (p.startsWith('{') && p.endsWith('}')) {
                        node = new Parser(new Lexer(p.slice(1, -1)).tokenize(), this.logger, "INTERP").parseExpr(0);
                    } else if (p.length > 0) {
                        node = { type: 'Literal', value: p };
                    }
                    if (node) root = root ? { type: 'Binary', op: '+', left: root, right: node } : node;
                }
                return this.tag(root || { type: 'Literal', value: "" });
            }
            return this.tag({ type: 'Literal', value: val });
        }

        if (t.type === 'REGEX') {
            const token = this.consume();
            return this.tag({ 
                type: 'RegexLiteral', 
                value: token.value,
                pattern: token.value,    
                flags: token.flags || "" 
            });
        }

        if (t.type === 'FN') {
            this.consume();
            if (this.peek().value !== '(') {
                this.error("Expected '(' after fn");
            }
            this.consume();
            let params = [];
            if (this.peek().value !== ')') {
                params.push(this.consume());
                while (this.peek().value === ',') {
                    this.consume();
                    params.push(this.consume());
                }
            }
            if (this.peek().value !== ')') {
                this.error("Expected ')' after fn parameters");
            }
            this.consume();
            const body = this.parseBlock('STOP_ON_RETURN', false);
            if (!body._terminatedByReturn) {
                this.error("fn literal is missing terminating '@'");
            }
            while (this.peek().type === 'NL') this.consume();
            if (this.peek().type === 'HASH' || this.peek().value === '#') this.consume();
            return this.tag({ type: 'FunctionDef', name: null, params, body });
        }

        if (t.type !== 'str' && t.value === '^') {
            this.consume();
            const next = this.consume();
            const key = next ? next.value : "^";
            return this.tag({ type: 'Literal', value: intern(String(key)) });
        }

        if (t.type === 'VEC_START') {
            return this.parseArrayLiteral(true);
        }

        if (t.type === 'HYB_EMPTY') {
            this.consume();
            return this.tag({ type: 'ArrayLiteral', elements: [], isVector: false, isHybridEmpty: true });
        }

        if (t.value === '[') {
            return this.parseArrayLiteral(false);
        }

        if (t.type === 'var' || t.type === 'ANY' || t.type === 'WITH' || t.type === 'LIMIT') {
            if (t.value === 'true') { this.consume(); return this.tag({ type: 'BooleanLiteral', value: true }); }
            if (t.value === 'false') { this.consume(); return this.tag({ type: 'BooleanLiteral', value: false }); }
            if (t.value === 'null') { this.consume(); return this.tag({ type: 'Literal', value: null }); }
            if (this.inNeuralBlock && String(t.value).toLowerCase() === 'any') {
                this.consume();
                return this.tag({ type: 'Literal', value: 'any' });
            }
            
            let name = intern(this.consume().value);

            if (this.peek().value === '(') {
                const KERNEL_TOOLS = new Set([
                    'len', 'type', 'push', 'pop', 'shift', 'unshift',
                    'sin', 'cos', 'tan', 'exp', 'log', 'log10', 'log2', 'trunc', 
                    'rand', 'rand_int', 'time', 'sleep', 'ord', 'char',
                    'chunk', 'tokenize', 'slice', 'split', 'join', 'upper', 'lower', 
                    'trim', 'replace', 'indexOf', 'startsWith', 'endsWith', 'repeat',
                    'padStart', 'padEnd', 'splice', 'fill', 'map', 'filter', 'forEach',
                    'reduce', 'some', 'every', 'sort', 'date', 'has',
                    'max', 'min', 'abs', 'floor', 'ceil', 'round', 'sqrt', 'pow',
                    'match', 'match_at', 'sub', 'contains', 'keys', 'values', 
                    'remove', 'merge', 'json_parse', 'json_str', 'clone', 
                    'unique', 'shuffle', 'reverse', 'clamp', 'lerp', 'sign',
                    'b64_enc', 'b64_dec', 'set_base', 'get_base', 'str', 'num', 'clock',
                    'dot_product', 'vec_add', 'vec_sub', 'vec_scale', 'vec_mag', 
                    'vec_norm', 'vec_dist', 'mat_mul', 'vec_softmax'
                ]);
                if (KERNEL_TOOLS.has(name)) name = '__builtin_' + name;
            }
            return this.tag({ type: 'Var', name: name });
        }

        if (t.value === '(') {
            this.consume();
            const expr = this.parseExpr(0);
            if (this.peek().value === ')') this.consume();
            return expr;
        }

        if (t.value === '{') {
            this.consume();
            const expr = this.parseExpr(0);
            if (this.peek().value === '}') this.consume();
            return expr;
        }

        return null;
    }
}

if (typeof __dk_window !== 'undefined') __dk_window.Parser = Parser;
if (typeof module !== 'undefined') module.exports = Parser;
