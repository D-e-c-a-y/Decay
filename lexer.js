var __dk_window = (typeof globalThis !== 'undefined' && globalThis.window) ? globalThis.window : ((typeof globalThis !== 'undefined') ? globalThis : {});

class Lexer {
    constructor(input) { this.input = input; }

    isDKPSigilChar(ch) {
        return /^[!#\$%&\(\)\*\+,\-\.\/:;<=>\?@\[\]\{\|\}~]$/.test(ch || "");
    }

    isStructuralSigilTerminator(ch) {
        return /^[\)\]\},;#]$/.test(ch || "");
    }

    isPotentialDKPSigilLiteral(text) {
        if (!text || text[0] !== '^' || text.length < 3) return false;
        const first = text[1];
        const second = text[2];
        if (!this.isDKPSigilChar(first) || !this.isDKPSigilChar(second)) return false;

        // Preserve one-char symbolic sigils in ordinary expression contexts:
        //   split(^.).join(^-)
        //   path.split(^/)
        // Without this guard, the lexer greedily swallows the closing
        // punctuation and reinterprets `^.)` as the DKP sigil literal `.)`.
        if (this.isStructuralSigilTerminator(second)) return false;

        return true;
    }

    error(msg, line) {
        throw new Error(`[LEXER ERROR] ${msg} at Line: ${line}`);
    }

    skipNL(tokens, i) {
        while (i < tokens.length && tokens[i].type === 'NL') i++;
        return i;
    }

    parseFlagLiteral(tokens, i) {
        i = this.skipNL(tokens, i);
        const tok = tokens[i];
        if (!tok) return null;

        if (tok.value === '[') {
            return this.parseFlagBracket(tokens, i);
        }
        if (tok.type === 'str') return { value: tok.value, next: i + 1 };
        if (tok.type === 'num') return { value: Number(tok.value), next: i + 1 };
        if (tok.type === 'var') {
            if (tok.value === 'true') return { value: true, next: i + 1 };
            if (tok.value === 'false') return { value: false, next: i + 1 };
            if (tok.value === 'null') return { value: null, next: i + 1 };
            return { value: tok.value, next: i + 1 };
        }
        return null;
    }

    parseFlagBracket(tokens, i) {
        if (!tokens[i] || tokens[i].value !== '[') return null;
        let j = this.skipNL(tokens, i + 1);
        const entries = [];
        let sawMapEntry = false;

        while (j < tokens.length && tokens[j].value !== ']') {
            const keyStart = this.skipNL(tokens, j);
            let key = null;
            let cursor = keyStart;

            if (tokens[cursor] && tokens[cursor].value === '^' && tokens[cursor + 1] && (tokens[cursor + 1].type === 'var' || tokens[cursor + 1].type === 'str')) {
                key = tokens[cursor + 1].value;
                cursor += 2;
            } else if (tokens[cursor] && (tokens[cursor].type === 'var' || tokens[cursor].type === 'str')) {
                key = tokens[cursor].value;
                cursor += 1;
            }

            cursor = this.skipNL(tokens, cursor);
            if (key !== null && tokens[cursor] && tokens[cursor].value === ':') {
                sawMapEntry = true;
                const parsedVal = this.parseFlagLiteral(tokens, cursor + 1);
                if (!parsedVal) return null;
                entries.push({ key, value: parsedVal.value, mapEntry: true });
                j = this.skipNL(tokens, parsedVal.next);
            } else {
                const parsedVal = this.parseFlagLiteral(tokens, j);
                if (!parsedVal) return null;
                entries.push({ value: parsedVal.value, mapEntry: false });
                j = this.skipNL(tokens, parsedVal.next);
            }

            if (tokens[j] && tokens[j].value === ',') {
                j = this.skipNL(tokens, j + 1);
            } else {
                j = this.skipNL(tokens, j);
            }
        }

        if (!tokens[j] || tokens[j].value !== ']') return null;

        if (sawMapEntry) {
            const out = {};
            for (const entry of entries) {
                if (entry.mapEntry) out[entry.key] = entry.value;
            }
            return { value: out, next: j + 1 };
        }
        return { value: entries.map(e => e.value), next: j + 1 };
    }

    extractEntryFlags(tokens) {
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (!t || t.type !== 'var' || t.value !== 'in') continue;

            let j = this.skipNL(tokens, i + 1);
            if (!tokens[j] || tokens[j].value !== '(') continue;
            j = this.skipNL(tokens, j + 1);
            if (!tokens[j] || tokens[j].value !== '[') continue;

            const parsed = this.parseFlagBracket(tokens, j);
            if (!parsed || typeof parsed.value !== 'object' || Array.isArray(parsed.value) || parsed.value === null) continue;
            let k = this.skipNL(tokens, parsed.next);
            if (!tokens[k] || tokens[k].value !== ')') continue;
            return parsed.value;
        }
        return null;
    }

    applyScriptFlags(flagMap) {
        if (typeof __dk_window === 'undefined' || !flagMap || typeof flagMap !== 'object') return;
        const existing = (__dk_window.DK_FLAGS && typeof __dk_window.DK_FLAGS === 'object') ? __dk_window.DK_FLAGS : {};
        const merged = { ...existing, ...flagMap };
        const parserMerged = { ...(existing.parser || {}) };

        if (flagMap.parser && typeof flagMap.parser === 'object' && !Array.isArray(flagMap.parser)) {
            Object.assign(parserMerged, flagMap.parser);
        }
        if (Object.prototype.hasOwnProperty.call(flagMap, 'allowImplicitNested')) {
            parserMerged.allowImplicitNested = !!flagMap.allowImplicitNested;
        }
        if (Object.keys(parserMerged).length > 0) {
            merged.parser = parserMerged;
        }
        __dk_window.DK_FLAGS = merged;
    }

    tokenize() {
        let tokens = []; 
        let pos = 0;
        let currentLine = 1;
        
        const rules = [
            { type: 'RETURN', regex: /^@|^return\b/ }, 
            { type: 'FN', regex: /^(?:fn|function)\b/ },
            { type: 'VEC_START', regex: /^\|\[/ },
            { type: 'HYB_EMPTY', regex: /^\[\/\]/ },
            { type: 'IF', regex: /^if\b/ },
            { type: 'ELSE', regex: /^else\b/ },
            { type: 'FOR', regex: /^for\b/ },
            { type: 'WHILE', regex: /^while\b/ },
            { type: 'TRY', regex: /^try\b/ },
            { type: 'ERR', regex: /^err\b/ },
            { type: 'THROW', regex: /^throw\b/ },
            { type: 'USE', regex: /^use\b/ },
            { type: 'AS', regex: /^as\b/ },
            { type: 'CLASS', regex: /^CLASS\b/i },
            { type: 'num', regex: /^[0-9]+(?:\.[0-9]+)?/ },
            { type: 'str', regex: /^"((?:[^"\\]|\\.)*)"/ },
            { type: 'REGEX', regex: /^\/((?:[^\\\/]|\\.)+)\/([gimuy]*)/ },
            { type: 'range', regex: /^\.\./ }, 
            { type: 'var', regex: /^[a-zA-Z_][a-zA-Z0-9_]*/ },
            { type: 'CLASS_SIGIL', regex: /^\*\*/ },
            { type: 'HASH',   regex: /^#/ },
            { type: 'op', regex: /^(==|!=|\+=|\-=|<=|>=|&&|\|\||[\+\-\*\/\=\<\>\!\(\)\[\]\,\.\:\^\{\}\;\&\|\%])|^\[|^\]/ }            
        ];
        
        while (pos < this.input.length) {
            let char = this.input[pos];
            
            if (char === '\n') {
                tokens.push({ type: 'NL', value: '\n', line: currentLine, start: pos, end: pos + 1 });
                currentLine++;
                pos++;
                continue;
            }
            if (/\s/.test(char)) { pos++; continue; }

            if (char === '^') {
                if (this.isPotentialDKPSigilLiteral(this.input.slice(pos))) {
                    tokens.push({
                        type: 'str',
                        value: this.input.slice(pos + 1, pos + 3),
                        line: currentLine,
                        start: pos,
                        end: pos + 3
                    });
                    pos += 3;
                    continue;
                }
            }
            
            const isDoubleSlash = this.input.slice(pos, pos+2) === '//';
            const isTilde = char === '~'; 
            
            if (isDoubleSlash || isTilde) { 
                pos += isDoubleSlash ? 2 : 1;
                while(pos < this.input.length && this.input[pos] !== '\n') {
                    pos++; 
                }
                continue; 
            }

            let match = false;
            for (let r of rules) {
                let m = this.input.slice(pos).match(r.regex);
                if (m) {
                    if (r.type === 'REGEX') {
                        let prev = tokens.length > 0 ? tokens[tokens.length-1] : null;
                        
                        // FIX: Safely added bracket closure guards for strict division matching!
                        if (prev && (prev.type === 'var' || prev.type === 'num' || prev.type === 'str' || prev.value === ')' || prev.value === ']' || prev.value === '^')) { 
                            continue; 
                        }
                        tokens.push({ type: 'REGEX', value: m[1], flags: m[2], line: currentLine, start: pos, end: pos + m[0].length });
                    } else if (r.type === 'str') {
                        try { tokens.push({ type: 'str', value: JSON.parse(m[0]), line: currentLine, start: pos, end: pos + m[0].length }); }
                        catch(e) { tokens.push({ type: 'str', value: m[1], line: currentLine, start: pos, end: pos + m[0].length }); }
                    } else {
                        let val = m[0];
                        let type = r.type;
                        if (type === 'var') { 
                            const keywordMap = {
                                'fn': 'FN', 'function': 'FN', 'switch': 'SWITCH',
                                'case': 'CASE', 'default': 'DEFAULT', 'break': 'BREAK',
                                'continue': 'CONTINUE',
                                'neural': 'NEURAL', 
                                'brain': 'BRAIN',
                                'solver': 'SOLVER'
                            };
                            if (keywordMap[val]) type = keywordMap[val];
                        }
                        tokens.push({ type, value: val, line: currentLine, start: pos, end: pos + m[0].length });
                    }
                    pos += m[0].length; 
                    match = true; 
                    break;
                }
            }
            if (!match) { 
                if (char === '/') { tokens.push({ type: 'op', value: '/', line: currentLine, start: pos, end: pos + 1 }); pos++; continue; } 
                if (char === '"') this.error("Unterminated string literal", currentLine);
                this.error(`Unexpected character '${char}'`, currentLine);
            }
        }
        tokens.push({ type: 'EOF', value: '', line: currentLine, start: pos, end: pos });
        const entryFlags = this.extractEntryFlags(tokens);
        if (entryFlags) this.applyScriptFlags(entryFlags);
        return tokens;
    }
}

if (typeof __dk_window !== 'undefined') __dk_window.Lexer = Lexer;
if (typeof module !== 'undefined') module.exports = Lexer;
