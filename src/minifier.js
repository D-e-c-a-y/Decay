class Minifier {
    constructor(input) {
        this.input = input;
    }

    minify(options = {}) {
        return this.minifyPass(this.input, options);
    }

    minifyPass(input, options = {}) {
        const traceEnabled = !!(typeof options === 'object' && options.trace);
        const onStep = (typeof options === 'object' && typeof options.onStep === 'function')
            ? options.onStep
            : null;

        const lexer = new Lexer(input);
        const tokens = lexer.tokenize();
        let output = "";
        let lastType = null;
        let lastVal = "";
        let lastIndex = -1;
        let lastClosedImplicitSignature = false;
        let sawNewline = false;
        let headerSeenOnLine = false;
        let atLineStart = true;
        let newlineAfterHeader = false;
        let aiBlockDepth = 0;
        const trace = [];

        for (let i = 0; i < tokens.length; i++) {
            let t = tokens[i];
            if (t.type === 'NL') {
                sawNewline = true;
                newlineAfterHeader = headerSeenOnLine;
                headerSeenOnLine = false;
                atLineStart = true;
                continue;
            }
            if (t.type === 'EOF') continue;

            let inserted = "";
            if (sawNewline && lastVal === '@' && t.value !== '#') {
                // Preserve bare return/newline boundaries when flattening to one line.
                // Without this, `@` can accidentally absorb the next declaration.
                output += "#";
                inserted = "#";
            }
            else if (sawNewline && aiBlockDepth > 0) {
                // AI DSL blocks are clause-oriented. Inside them, newline should
                // collapse to a plain space so line-separated clauses remain in
                // the same block rather than becoming separate statements.
                output += " ";
                inserted = " ";
            }
            else if (
                sawNewline &&
                !newlineAfterHeader &&
                this.needsSoftStatementBoundary(tokens, lastIndex, lastType, lastVal, i) &&
                this.startsStatementToken(tokens, i) &&
                !lastClosedImplicitSignature
            ) {
                // Preserve a visible boundary between adjacent statements, but
                // prefer plain space over synthetic semicolons when possible.
                output += " ";
                inserted = " ";
            }
            else if (lastClosedImplicitSignature && t.value !== '#' && t.value !== ';' && t.value !== ':') {
                // Canonicalize implicit function bodies into explicit `:`
                // form in minified output. This keeps one-line implicit
                // declarations parseable without relying on original line layout.
                output += ":";
                inserted = ":";
            }
            else if (
                sawNewline &&
                this.startsClassDeclaration(t) &&
                this.canEndStatement(tokens, lastIndex, lastType, lastVal) &&
                !lastClosedImplicitSignature
            ) {
                // Keep a hard boundary before class declarations that start on a new
                // line, otherwise constructs like `pick() / class X` can collapse
                // into one ambiguous statement.
                output += " ";
                inserted = " ";
            }
            else if (
                sawNewline &&
                this.startsImplicitFunctionSignature(tokens, i) &&
                this.canEndStatement(tokens, lastIndex, lastType, lastVal) &&
                !lastClosedImplicitSignature
            ) {
                // Preserve a statement boundary before an implicit function declaration
                // that starts on a new line. Without this, nested forms like:
                //   total = 0
                //   make(seed)
                // can collapse into `total=0 make(seed)...` and trigger the parser's
                // same-line nested ambiguity checks.
                output += " ";
                inserted = " ";
            }
            else if (
                sawNewline &&
                ['CLASS', 'CLASS_SIGIL'].includes(lastType) &&
                t.value !== '#' &&
                t.value !== ';'
            ) {
                // Preserve the boundary after class terminators so the next
                // declaration or statement does not get glued onto the class.
                output += " ";
                inserted = " ";
            }
            else if (sawNewline && this.needsBoundarySpaceAfterNewline(lastType, t.type, lastVal, t.value)) {
                output += " ";
                inserted = " ";
            }
            else if (lastType === 'CLASS_SIGIL' && t.type === 'CLASS_SIGIL') {
                output += " ";
                inserted = " ";
            }
            else if (this.needsSpace(lastType, t.type, lastVal, t.value)) {
                output += " ";
                inserted = " ";
            }

            let piece = "";
            if (this.isAiIdentifierReference(tokens, i)) {
                piece = `(${t.value})`;
            } else if (t.type === 'str') {
                piece = JSON.stringify(t.value);
            } else if (t.type === 'REGEX') {
                piece = `/${t.value}/${t.flags || ''}`;
            } else {
                piece = t.value;
            }
            output += piece;

            if (traceEnabled || onStep) {
                const step = {
                    index: i,
                    tokenType: t.type,
                    tokenValue: t.value,
                    inserted,
                    piece,
                    output
                };
                if (traceEnabled) trace.push(step);
                if (onStep) onStep(step);
            }

            lastType = t.type;
            lastVal = t.value;
            lastIndex = i;
            if (this.startsAiBlock(tokens, i)) aiBlockDepth++;
            else if (t.value === '#' && aiBlockDepth > 0) aiBlockDepth--;
            lastClosedImplicitSignature = this.endsImplicitFunctionSignature(tokens, i);
            if (atLineStart && this.tokenStartsMultilineHeader(tokens, i)) {
                headerSeenOnLine = true;
            }
            sawNewline = false;
            newlineAfterHeader = false;
            atLineStart = false;
        }

        const code = output.trim();
        if (traceEnabled) return { code, trace };
        return code;
    }

    // Keep one-line output while preserving statement boundaries where
    // postfix "[" would otherwise attach to the previous expression.
    needsBoundarySpaceAfterNewline(lastType, currentType, lastVal, currentVal) {
        if (!lastType) return false;

        const prevCanEndExpr =
            ['var', 'num', 'str', 'REGEX', 'HASH'].includes(lastType) ||
            (lastType === 'op' && [')', ']'].includes(lastVal));

        const nextIsIndexStart = currentType === 'op' && currentVal === '[';
        return prevCanEndExpr && nextIsIndexStart;
    }

    canEndStatement(tokens, index, lastType, lastVal) {
        if (!lastType) return false;
        if (index >= 0 && ['BRAIN', 'NEURAL', 'SOLVER'].includes(lastType)) {
            return this.isAiIdentifier(tokens, index);
        }
        return (
            ['var', 'num', 'str', 'REGEX', 'HASH', 'BREAK', 'CONTINUE', 'FN'].includes(lastType) ||
            (lastType === 'op' && [')', ']','}'].includes(lastVal))
        );
    }

    needsSoftStatementBoundary(tokens, index, lastType, lastVal, nextIndex) {
        if (!this.canEndStatement(tokens, index, lastType, lastVal)) return false;

        // If the previous statement already ends in a hard expression closer,
        // the parser can usually separate the next statement without an extra
        // space. Keeping those spaces makes first-pass output non-idempotent
        // because the second pass naturally strips them.
        if (lastType === 'op' && [')', ']', '}'].includes(lastVal)) {
            const next = tokens[nextIndex];
            if (!next) return false;

            // Still keep soft boundaries for the cases handled elsewhere:
            // - postfix indexing after newline
            // - class declarations
            // - implicit function declarations
            if (next.value === '[') return true;
            if (this.startsClassDeclaration(next)) return true;
            if (this.startsImplicitFunctionSignature(tokens, nextIndex)) return true;

            return false;
        }

        return true;
    }

    startsImplicitFunctionSignature(tokens, index) {
        const first = tokens[index];
        if (!first || first.type !== 'var') return false;
        if (!tokens[index + 1] || tokens[index + 1].value !== '(') return false;

        const prev = tokens[index - 1];
        const startsAtDeclarationBoundary =
            index === 0 ||
            (prev && prev.type === 'NL') ||
            (prev && prev.type === 'HASH') ||
            (prev && prev.type === 'CLASS_SIGIL') ||
            (prev && prev.type === 'CLASS') ||
            (prev && prev.type === 'op' && prev.value === ';');

        if (!startsAtDeclarationBoundary) return false;

        let i = index + 2;
        let depth = 1;
        while (i < tokens.length && tokens[i].type !== 'EOF') {
            const tok = tokens[i];
            if (tok.value === '(') depth++;
            else if (tok.value === ')') depth--;
            else if (depth === 1) {
                if (tok.type !== 'var' && tok.value !== ',' && tok.type !== 'NL') return false;
            }
            i++;
            if (depth === 0) break;
        }
        if (depth !== 0) return false;

        while (i < tokens.length && tokens[i].type === 'NL') i++;
        const next = tokens[i];
        if (!next) return false;

        const bodyStarterTypes = new Set([
            'var', 'IF', 'FOR', 'WHILE', 'SWITCH', 'TRY', 'USE',
            'RETURN', 'THROW', 'BREAK', 'CONTINUE', 'CLASS'
        ]);
        // Explicit forms are already canonical and must not be treated as
        // newline-implicit signatures on later minify passes.
        if (next.value === ':') return false;
        if (next.value === '{') return false;
        if (next.value === '@') return true;
        if (!bodyStarterTypes.has(next.type)) return false;

        // Newline-based implicit declarations require an indented body on the
        // following line. Without this guard, ordinary calls such as
        // `modArr(myA)` followed by another statement get re-labeled as
        // declarations and acquire a bogus trailing `:`.
        if (next.line > first.line) {
            return this.tokenIndent(next) > this.tokenIndent(first);
        }

        return true;
    }

    endsImplicitFunctionSignature(tokens, index) {
        const tok = tokens[index];
        if (!tok || tok.value !== ')') return false;

        let depth = 0;
        for (let i = index; i >= 0; i--) {
            const cur = tokens[i];
            if (cur.value === ')') depth++;
            else if (cur.value === '(') {
                depth--;
                if (depth === 0) {
                    const nameTok = tokens[i - 1];
                    if (!nameTok || nameTok.type !== 'var') return false;
                    return this.startsImplicitFunctionSignature(tokens, i - 1);
                }
            }
        }
        return false;
    }

    startsClassDeclaration(token) {
        return !!token && (token.type === 'CLASS' || token.type === 'CLASS_SIGIL');
    }

    startsStatementToken(tokens, index) {
        const tok = tokens[index];
        if (!tok) return false;

        if ([
            'IF', 'FOR', 'WHILE', 'TRY', 'THROW', 'USE', 'SWITCH',
            'BREAK', 'CONTINUE', 'RETURN', 'CLASS', 'CLASS_SIGIL', 'FN'
        ].includes(tok.type)) {
            return true;
        }

        if (['BRAIN', 'NEURAL', 'SOLVER'].includes(tok.type) && this.isAiIdentifier(tokens, index, { requireAssignment: true })) {
            return true;
        }

        if (['var', 'num', 'str', 'REGEX', 'HASH'].includes(tok.type)) {
            return true;
        }

        if (tok.type === 'op' && ['[', '{', '('].includes(tok.value)) {
            return true;
        }

        return false;
    }

    tokenStartsMultilineHeader(tokens, index) {
        const tok = tokens[index];
        if (!tok) return false;

        if (['IF', 'FOR', 'WHILE', 'TRY', 'ERR', 'SWITCH', 'CASE', 'DEFAULT', 'ELSE'].includes(tok.type)) {
            return true;
        }

        if ((tok.type === 'CLASS' || tok.type === 'CLASS_SIGIL') && this.isClassHeader(tokens, index)) {
            return true;
        }

        return false;
    }

    isClassHeader(tokens, index) {
        const tok = tokens[index];
        if (!tok || !['CLASS', 'CLASS_SIGIL'].includes(tok.type)) return false;
        const line = tok.line;
        for (let i = index + 1; i < tokens.length; i++) {
            const next = tokens[i];
            if (!next || next.type === 'EOF') return false;
            if (next.type === 'NL') return false;
            if (next.line !== line) return false;
            return next.type === 'var';
        }
        return false;
    }

    startsAiBlock(tokens, index) {
        const tok = tokens[index];
        if (!tok || !['BRAIN', 'NEURAL', 'SOLVER'].includes(tok.type)) return false;

        let prevIndex = index - 1;
        while (prevIndex >= 0 && tokens[prevIndex].type === 'NL') prevIndex--;
        const prev = tokens[prevIndex];
        if (prev && prev.type === 'op' && prev.value === '.') return false;

        let j = index + 1;
        while (j < tokens.length && tokens[j].type === 'NL') j++;
        const next = tokens[j];
        if (!next) return false;
        if (next.type === 'op' && next.value === '=') return false;

        if (tok.type === 'BRAIN') {
            if (this.isBrainClauseStart(tokens, j)) return true;
            if (!this.isDslAliasToken(next)) return false;
            j++;
            while (j < tokens.length && tokens[j].type === 'NL') j++;
            return this.isBrainClauseStart(tokens, j);
        }

        if (tok.type === 'SOLVER') {
            if (this.isSolverClauseStart(tokens, j)) return true;
            if (!this.isDslAliasToken(next)) return false;
            j++;
            while (j < tokens.length && tokens[j].type === 'NL') j++;
            return this.isSolverClauseStart(tokens, j);
        }

        if (tok.type === 'NEURAL') {
            if (this.isNeuralClauseStart(tokens, j)) return true;
            if (!this.isDslAliasToken(next)) return false;
            j++;
            while (j < tokens.length && tokens[j].type === 'NL') j++;
            return this.isNeuralClauseStart(tokens, j);
        }

        return false;
    }

    isDslAliasToken(tok) {
        return !!tok && ['var', 'BRAIN', 'NEURAL', 'SOLVER'].includes(tok.type);
    }

    isClauseKeyword(tok, words) {
        if (!tok) return false;
        if (tok.type === 'CASE' && words.has('case')) return true;
        const lower = typeof tok.value === 'string' ? tok.value.toLowerCase() : tok.value;
        return tok.type === 'var' && words.has(lower);
    }

    isBrainClauseStart(tokens, index) {
        const tok = tokens[index];
        if (!tok) return false;
        if (tok.type === 'USE') return true;
        if (tok.type === 'op' && tok.value === '[') return true;
        return this.isClauseKeyword(tok, new Set([
            'use', 'config', 'with', 'entry', 'exit', 'limit', 'stop',
            'sample', 'identity', 'memory', 'stream', 'callback', 'prompt'
        ]));
    }

    isSolverClauseStart(tokens, index) {
        const tok = tokens[index];
        if (!tok) return false;
        if (tok.type === 'op' && tok.value === '[') return true;
        return this.isClauseKeyword(tok, new Set([
            'rules', 'prefer', 'optimize', 'mode', 'limit', 'timeout'
        ]));
    }

    isNeuralClauseStart(tokens, index) {
        const tok = tokens[index];
        if (!tok) return false;
        if (tok.type === 'op' && tok.value === '[') return true;
        if (this.isClauseKeyword(tok, new Set(['with', 'limit', 'fallback', 'case']))) {
            return true;
        }

        if (!this.isDslAliasToken(tok)) return false;
        let j = index + 1;
        while (j < tokens.length && tokens[j].type === 'NL') j++;
        const next = tokens[j];
        return !!next && next.type === 'op' && next.value === '[';
    }

    isAiIdentifier(tokens, index, options = {}) {
        const tok = tokens[index];
        if (!tok || !['BRAIN', 'NEURAL', 'SOLVER'].includes(tok.type)) return false;
        if (this.startsAiBlock(tokens, index)) return false;

        let j = index + 1;
        while (j < tokens.length && tokens[j].type === 'NL') j++;
        const next = tokens[j];
        if (options.requireAssignment) {
            return !!next && next.type === 'op' && next.value === '=';
        }
        return !(next && next.type === 'op' && next.value === '=');
    }

    isAiIdentifierReference(tokens, index) {
        const tok = tokens[index];
        if (!tok || !['BRAIN', 'NEURAL', 'SOLVER'].includes(tok.type)) return false;
        if (!this.isAiIdentifier(tokens, index)) return false;

        let prevIndex = index - 1;
        while (prevIndex >= 0 && tokens[prevIndex].type === 'NL') prevIndex--;
        const prev = tokens[prevIndex];
        if (prev && prev.type === 'op' && prev.value === '.') return false;
        if (prevIndex >= 0 && this.startsAiBlock(tokens, prevIndex)) return false;

        return true;
    }

    tokenIndent(token) {
        if (!token || typeof token.start !== 'number') return 0;
        let cursor = token.start - 1;
        while (cursor >= 0 && this.input[cursor] !== '\n') cursor--;
        return token.start - (cursor + 1);
    }

    needsSpace(lastType, currentType, lastVal, currentVal) {
        if (!lastType) return false;

        const isWordType = (type) => [
            'var', 'num', 'FN', 'RETURN', 'IF', 'ELSE', 'FOR',
            'USE', 'AS', 'TRY', 'ERR', 'THROW', 'BREAK', 'CONTINUE',
            'SWITCH', 'CASE', 'DEFAULT', 'CLASS', 'NEURAL', 'BRAIN', 'SOLVER'
        ].includes(type);

        const isWordValue = (val) => /[A-Za-z_0-9]/.test((val || '').slice(-1));
        const isWord = (type, val) => isWordType(type) || isWordValue(val);
        
        // RULE 1: Preserve space between any two keywords/identifiers/numbers
        if (isWord(lastType, lastVal) && isWord(currentType, currentVal)) return true;
        
        // RULE 2: Preserve space between string/regex and keywords 
        // to prevent '""switch' boundary issues in parseExpr
        if ((lastType === 'str' || lastType === 'REGEX') && isWord(currentType, currentVal)) return true;

        // RULE 3: Operator safety
        if (lastType === 'op' && currentType === 'op') {
            if (lastVal === '+' && currentVal.startsWith('+')) return true;
            if (lastVal === '-' && currentVal.startsWith('-')) return true;
            if (lastVal === '=' && currentVal.startsWith('=')) return true;
        }

        // RULE 4: AI/solver block starters must keep a boundary before '['.
        // Without this, `solver[` / `brain[` / `neural[` are re-read as
        // variable indexing instead of block syntax during parsing.
        if (['NEURAL', 'BRAIN', 'SOLVER'].includes(lastType) && currentVal === '[') {
            return true;
        }

        return false;
    }
}

if (typeof window !== 'undefined') {
    window.Minifier = Minifier;
}
if (typeof module !== 'undefined') {
    module.exports = Minifier;
}
