var __dk_window = (typeof globalThis !== 'undefined' && globalThis.window)
    ? globalThis.window
    : ((typeof globalThis !== 'undefined') ? globalThis : {});
const DEFAULT_DKP_SIGILS = Object.freeze(["!!", "??", "::", "++", "~~"]);
const DKP_SIGIL_CHAR_RE = /^[!#\$%&\(\)\*\+,\-\.\/:;<=>\?@\[\]\{\|\}~]$/;

class VM {
    constructor(logger) {
        this.logger = logger || console.log;
        
        this.stackSize = 4096;
        this.stack = new Array(this.stackSize).fill(null);
        this.sp = 0; 
        this.bp = 0; 
        
        this.frames = []; 
        this.frameCount = 0;
        
        this.tryStack = [];
        this.loopStack = [];
        this.globals = new Map();
        this.globalFunctions = new Map();
        this.systemTools = new Map();
        this.openUpvalues = null; 

        this.opTrace = [];
        this.opTraceMax = 32;
        
        this.initNativeFunctions();
        this.traceExecution = false; 
        this.debug = false;
        this.clearOnPop = false;
        this._argsBuf = [];
        this.numStack = new Float64Array(this.stackSize);
        this.numMask = new Uint8Array(this.stackSize);

        this.MOCK_FS = null;
        this.host = null;
        this.currentScriptPath = null;
        this.Lexer = null;
        this.Parser = null;
        this.Compiler = null;
        this.Minifier = null;
        this.DKMin = null;
        this.lastRunMeta = { parseWarnings: 0, parseWarningMessages: [] };
        this.brainMemory = new Map();

        this.globalBase = 1; // Unified Friendly-First Default
        this.dkpSigils = new Set(DEFAULT_DKP_SIGILS);
        this.setRuntimeFlags({});
    }

    toDKFlagValue(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

        if (ArrayBuffer.isView(value)) return value;
        if (this.isDKWrapper(value)) return value;

        if (Array.isArray(value)) {
            const items = value.map(v => this.toDKFlagValue(v));
            const arr = (typeof __dk_window.dkArrayCreate === "function")
                ? __dk_window.dkArrayCreate(items, 1)
                : items;
            if (!__dk_window.dkArrayCreate) {
                Object.defineProperty(arr, "__dk_base", {
                    value: 1,
                    writable: true,
                    configurable: true,
                    enumerable: false
                });
            }
            return arr;
        }

        if (typeof value === 'object') {
            const out = { type: 'arr', data: [null], _base: 1, _isMap: true };
            for (const key of Object.keys(value)) {
                out.data['^' + key] = this.toDKFlagValue(value[key]);
            }
            return out;
        }

        return null;
    }

    setRuntimeFlags(flags) {
        const isDKMap = !!(flags && typeof flags === 'object' && flags.type === 'arr' && flags.data);
        const normalized = isDKMap ? flags : this.toDKFlagValue(flags || {});
        this.globals.set("__dk_flags", normalized || { type: 'arr', data: [null], _base: 1 });
    }

    hostValueToJS(value) {
        if (value === null || value === undefined) return null;
        const toJSFn = __dk_window.toJS;
        if (typeof toJSFn === "function") return toJSFn(value);
        return value;
    }

    hostValueFromJS(value) {
        if (value === undefined) return null;
        const toDKFn = __dk_window.toDK;
        if (typeof toDKFn === "function") return toDKFn(value);
        return value ?? null;
    }

    makeDKError(msg, options = {}) {
        const {
            type = "SystemError",
            code = null,
            line = null,
            location = null
        } = options || {};
        const data = [null];
        data["^msg"] = String(msg ?? "Unknown error");
        data["^type"] = type;
        if (code !== null && code !== undefined) data["^code"] = String(code);
        if (line !== null && line !== undefined) data["^line"] = line;
        if (location !== null && location !== undefined) data["^location"] = String(location);
        return { type: "arr", data, _base: 1 };
    }

    coerceDKError(error, fallback = {}) {
        if (error && typeof error === 'object' && (error.type === 'arr' || this.isDKArray(error) || ArrayBuffer.isView(error))) {
            return error;
        }

        const defaultType = error instanceof Error ? "SystemError" : "Error";
        const defaultCode = error instanceof Error ? "SYSTEM_ERROR" : "ERROR";
        const fallbackType = fallback.type || defaultType;
        const fallbackCode = fallback.code || defaultCode;
        const fallbackLine = (fallback.line !== undefined) ? fallback.line : null;
        const fallbackLocation = fallback.location || null;

        const rawMsg =
            error instanceof Error
                ? String(error.message || error)
                : String(error ?? "Unknown error");

        const phaseMatchers = [
            { prefix: "[LEXER ERROR]", type: "LexerError", code: "LEXER_ERROR" },
            { prefix: "[PARSER ERROR]", type: "ParserError", code: "PARSER_ERROR" },
            { prefix: "[COMPILER ERROR]", type: "CompilerError", code: "COMPILER_ERROR" },
            { prefix: "[MINIFIER ERROR]", type: "MinifierError", code: "MINIFIER_ERROR" },
            { prefix: "[VM INVARIANT]", type: "VMInvariantError", code: "VM_INVARIANT" }
        ];

        let type = fallbackType;
        let code = fallbackCode;
        for (const phase of phaseMatchers) {
            if (rawMsg.startsWith(phase.prefix)) {
                type = phase.type;
                code = phase.code;
                break;
            }
        }

        const lineMatch = rawMsg.match(/at Line:\s*([0-9]+)/);
        const parsedLine = lineMatch ? Number(lineMatch[1]) : null;
        const line = parsedLine !== null ? parsedLine : fallbackLine;
        const normalizedMsg = /at Line:\s*/.test(rawMsg)
            ? rawMsg
            : `${rawMsg} at Line: ${line !== null && line !== undefined ? line : "Unknown"}`;
        return this.makeDKError(normalizedMsg, { type, code, line, location: fallbackLocation });
    }

    describeError(error) {
        if (error && typeof error === "object" && error.type === "arr" && error.data) {
            return String(error.data["^msg"] || error.data.msg || "[DK ERROR]");
        }
        if (error instanceof Error) return String(error.message || error);
        return String(error ?? "Unknown error");
    }

    makeDKPError(msg, code, location = "dkp") {
        return this.makeDKError(msg, {
            type: "DKPError",
            code,
            location
        });
    }

    isValidDKPSigilShape(rawSigil) {
        const sigil = String(rawSigil == null ? "" : rawSigil).trim();
        return sigil.length === 2 && DKP_SIGIL_CHAR_RE.test(sigil[0]) && DKP_SIGIL_CHAR_RE.test(sigil[1]);
    }

    normalizeCustomDKPSigil(rawSigil, location = "DKP_define_sigil") {
        const sigil = String(rawSigil == null ? "" : rawSigil).trim();
        if (!this.isValidDKPSigilShape(sigil)) {
            throw this.makeDKPError(`Invalid DKP sigil '${sigil}'`, "DKP_INVALID_SIGIL", location);
        }
        return sigil;
    }

    getDKPSigils() {
        return new Set(this.dkpSigils);
    }

    getDKPSigilList() {
        return Array.from(this.dkpSigils);
    }

    setDKPSigils(sigils, location = "DKP_set_sigils") {
        if (!Array.isArray(sigils)) {
            throw this.makeDKPError("DKP_set_sigils requires an array of sigils", "DKP_INVALID_SIGIL_STORE", location);
        }
        const next = new Set();
        for (const sigil of sigils) {
            next.add(this.normalizeCustomDKPSigil(sigil, location));
        }
        this.dkpSigils = next;
        return this.getDKPSigilList();
    }

    addDKPSigil(rawSigil, location = "DKP_define_sigil") {
        const sigil = this.normalizeCustomDKPSigil(rawSigil, location);
        this.dkpSigils.add(sigil);
        return sigil;
    }

    removeDKPSigil(rawSigil, location = "DKP_remove_sigil") {
        const sigil = this.normalizeCustomDKPSigil(rawSigil, location);
        return this.dkpSigils.delete(sigil);
    }

    resetDKPSigils() {
        this.dkpSigils = new Set(DEFAULT_DKP_SIGILS);
        return this.getDKPSigilList();
    }

    normalizeDKPSigil(rawSigil, location = "DKP_pack") {
        const sigil = this.normalizeCustomDKPSigil(rawSigil, location);
        if (!this.getDKPSigils().has(sigil)) {
            throw this.makeDKPError(`Unrecognized DKP sigil '${sigil}'`, "DKP_INVALID_SIGIL", location);
        }
        return sigil;
    }

    resolveDKPMinifierCtor() {
        return this.Minifier ||
            ((typeof Minifier !== "undefined") ? Minifier : null) ||
            ((typeof __dk_window !== "undefined" && __dk_window.Minifier) ? __dk_window.Minifier : null);
    }

    minifyDKPSource(source) {
        const MinifierCtor = this.resolveDKPMinifierCtor();
        if (!MinifierCtor) {
            throw this.makeDKPError("DKP_pack requires the real DK minifier in this host", "DKP_SEND_FAILED", "DKP_pack");
        }
        const minifier = new MinifierCtor(String(source == null ? "" : source));
        return String(minifier.minify());
    }

    buildDKPMap(values = {}) {
        const out = { type: "arr", data: [null], _base: 1 };
        for (const [key, value] of Object.entries(values)) {
            out.data["^" + key] = value;
            out.data[key] = value;
        }
        return out;
    }

    packDKPPulse(sigil, source) {
        const normalizedSigil = this.normalizeDKPSigil(sigil, "DKP_pack");
        const minified = this.minifyDKPSource(source);
        const body = String(minified == null ? "" : minified).trim();
        if (!body) {
            throw this.makeDKPError("DKP pulse content is empty after minification", "DKP_EMPTY_CONTENT", "DKP_pack");
        }
        if (/[\r\n]/.test(body)) {
            throw this.makeDKPError("DKP pulse body must be a single line", "DKP_INVALID_PACKET", "DKP_pack");
        }
        return normalizedSigil + " " + body;
    }

    unpackDKPPulse(packet, location = "DKP_unpack") {
        const rawPacket = String(packet == null ? "" : packet);
        if (/[\r\n]/.test(rawPacket)) {
            throw this.makeDKPError("DKP packet must not contain CR or LF characters", "DKP_INVALID_PACKET", location);
        }
        if (rawPacket.length < 4) {
            throw this.makeDKPError("DKP packet is malformed", "DKP_INVALID_PACKET", location);
        }
        const sigil = rawPacket.slice(0, 2);
        if (!this.getDKPSigils().has(sigil)) {
            throw this.makeDKPError(`Unrecognized DKP sigil '${sigil}'`, "DKP_INVALID_SIGIL", location);
        }
        if (rawPacket[2] !== " ") {
            throw this.makeDKPError("DKP packet must contain exactly one ASCII space after the sigil", "DKP_INVALID_PACKET", location);
        }
        const body = rawPacket.slice(3);
        if (!body || body[0] === " ") {
            throw this.makeDKPError("DKP packet must contain a non-empty body after exactly one ASCII space", "DKP_INVALID_PACKET", location);
        }
        return this.buildDKPMap({
            packet: rawPacket,
            sigil,
            source: body
        });
    }

    vmInvariant(condition, message) {
        if (!condition) throw new Error(`[VM INVARIANT] ${message}`);
    }

    pruneDeadLoopState(maxFrameCount) {
        while (this.loopStack.length > 0) {
            const top = this.loopStack[this.loopStack.length - 1];
            if (!top || typeof top.frameCount !== "number" || top.frameCount > maxFrameCount) {
                this.loopStack.pop();
                continue;
            }
            break;
        }
    }

    pruneDeadTryState(maxFrameCount) {
        while (this.tryStack.length > 0) {
            const top = this.tryStack[this.tryStack.length - 1];
            if (!top || typeof top.frameCount !== "number" || top.frameCount > maxFrameCount) {
                this.tryStack.pop();
                continue;
            }
            break;
        }
    }

    closeUpvaluesAtOrAbove(stackFloor) {
        if (!Number.isFinite(stackFloor)) return;
        this.closeUpvalues(stackFloor);
    }

    assertRuntimeState(label, currentFrame = null) {
        this.vmInvariant(Number.isInteger(this.sp) && this.sp >= 0 && this.sp <= this.stackSize, `${label}: invalid sp ${this.sp}`);
        this.vmInvariant(Number.isInteger(this.frameCount) && this.frameCount >= 0, `${label}: invalid frameCount ${this.frameCount}`);
        this.vmInvariant(this.frames.length >= this.frameCount, `${label}: frames array shorter than frameCount (${this.frames.length} < ${this.frameCount})`);
        this.vmInvariant(Number.isInteger(this.bp) && this.bp >= -1 && this.bp <= this.sp, `${label}: invalid bp ${this.bp} for sp ${this.sp}`);
        if (this.frameCount > 0) {
            const liveFrame = currentFrame || this.frames[this.frameCount - 1];
            this.vmInvariant(!!liveFrame, `${label}: missing active frame`);
            this.vmInvariant(Number.isInteger(liveFrame.bp), `${label}: active frame missing bp`);
            this.vmInvariant(this.bp === liveFrame.bp, `${label}: bp drifted from active frame (${this.bp} != ${liveFrame.bp})`);
            this.vmInvariant(this.sp >= liveFrame.bp, `${label}: sp below active frame bp (${this.sp} < ${liveFrame.bp})`);
        }
        for (let i = 0; i < this.tryStack.length; i++) {
            const handler = this.tryStack[i];
            this.vmInvariant(handler && Number.isInteger(handler.frameCount), `${label}: malformed try handler at ${i}`);
            this.vmInvariant(handler.frameCount <= this.frameCount, `${label}: try handler ${i} points past live frames (${handler.frameCount} > ${this.frameCount})`);
            this.vmInvariant(Number.isInteger(handler.sp) && handler.sp >= 0 && handler.sp <= this.stackSize, `${label}: try handler ${i} has invalid sp ${handler.sp}`);
            this.vmInvariant(Number.isInteger(handler.bp) && handler.bp >= -1 && handler.bp <= handler.sp, `${label}: try handler ${i} has invalid bp ${handler.bp}`);
        }
        for (let i = 0; i < this.loopStack.length; i++) {
            const loop = this.loopStack[i];
            this.vmInvariant(loop && Number.isInteger(loop.frameCount), `${label}: malformed loop frame at ${i}`);
            this.vmInvariant(loop.frameCount <= this.frameCount, `${label}: loop frame ${i} points past live frames (${loop.frameCount} > ${this.frameCount})`);
            this.vmInvariant(Number.isInteger(loop.frameBp), `${label}: loop frame ${i} missing frameBp`);
            this.vmInvariant(loop.frameBp >= -1 && loop.frameBp <= this.sp, `${label}: loop frame ${i} has invalid frameBp ${loop.frameBp}`);
        }
        let upvalue = this.openUpvalues;
        let previousLocation = Infinity;
        while (upvalue != null) {
            if (upvalue.isClosed || upvalue.location === -1) {
                this.vmInvariant(upvalue.location === -1, `${label}: closed upvalue retained invalid location ${upvalue.location}`);
            } else {
                this.vmInvariant(Number.isInteger(upvalue.location) && upvalue.location >= 0 && upvalue.location < this.stackSize, `${label}: open upvalue location out of range (${upvalue.location})`);
                this.vmInvariant(upvalue.location <= previousLocation, `${label}: open upvalues out of order (${upvalue.location} > ${previousLocation})`);
                previousLocation = upvalue.location;
            }
            upvalue = upvalue.next;
        }
    }

    brainToJS(val) {
        if (val === null || val === undefined) return null;
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
        if (this.isStringView(val)) return String(val.text ?? "");
        if (ArrayBuffer.isView(val)) return Array.from(val);
        if (this.isDKWrapper(val)) {
            const out = [];
            const len = this.getArrayLength(val);
            for (let i = 0; i < len; i++) out.push(this.brainToJS(this.getArrayValue(val, this.getArrayBase(val) + i)));
            for (const k of Object.keys(val.data || {})) {
                if (!k.startsWith("^")) continue;
                out[k.slice(1)] = this.brainToJS(val.data[k]);
            }
            return out;
        }
        if (this.isDKArray(val)) return Array.from(val).map(v => this.brainToJS(v));
        if (Array.isArray(val)) return val.map(v => this.brainToJS(v));
        if (typeof val === "object") {
            const out = {};
            for (const k of Object.keys(val)) out[k] = this.brainToJS(val[k]);
            return out;
        }
        return val;
    }

    getBrainLegendNames(legend) {
        if (!legend) return ["l", "h", "w"];
        if (Array.isArray(legend)) return legend.map(v => String(this.brainToJS(v)));
        if (legend.type === "ArrayLiteral" && Array.isArray(legend.elements)) {
            return legend.elements.map(e => {
                if (!e) return "";
                if (e.name) return String(e.name);
                if (e.value !== undefined) return String(e.value);
                return "";
            });
        }
        return ["l", "h", "w"];
    }

    getBrainResources(uses) {
        const resources = [];
        if (!Array.isArray(uses)) return resources;
        for (const u of uses) {
            if (!u || !u.path) continue;
            const path = String(u.path);
            const lower = path.toLowerCase();
            let kind = "aux";
            if ((u.label && String(u.label).toLowerCase() === "weights") || lower.endsWith(".gguf") || lower.endsWith(".bin") || lower.endsWith(".safetensors")) kind = "weights";
            else if ((u.label && String(u.label).toLowerCase() === "vocab") || lower.endsWith(".json") || lower.endsWith(".model")) kind = "vocab";
            resources.push({ label: u.label || "auto", path, kind });
        }
        return resources;
    }

    normalizeBrainLegendName(name) {
        const raw = String(name == null ? "" : name).trim().toLowerCase();
        if (raw === "l" || raw === "layer" || raw === "layers") return "l";
        if (raw === "h" || raw === "head" || raw === "heads") return "h";
        if (raw === "w" || raw === "width" || raw === "hidden" || raw === "embed" || raw === "embedding") return "w";
        return raw;
    }

    makeBrainTopologyPlan(rowsInput, legend, entrySize, exitSize, options = {}) {
        const source = String(options.source || "brain");
        const explicitLegend = options.legend !== undefined ? options.legend : legend;
        const rawLegend = Array.isArray(explicitLegend) ? explicitLegend.slice() : this.getBrainLegendNames(explicitLegend);
        const legendNames = (rawLegend.length > 0 ? rawLegend : ["l", "h", "w"]).map(name => this.normalizeBrainLegendName(name));
        const supportedLegend = new Set(["l", "h", "w"]);
        const seenLegend = new Set();
        for (const name of legendNames) {
            if (!supportedLegend.has(name) || seenLegend.has(name)) {
                throw this.makeDKError(`Brain topology legend in '${source}' must be a permutation of [l, h, w]`, {
                    type: "BrainError",
                    code: "BRAIN_INVALID_TOPOLOGY",
                    location: `brain:topology:${source}`
                });
            }
            seenLegend.add(name);
        }

        const rows = [];
        const state = {};
        const inputRows = Array.isArray(rowsInput) ? rowsInput : [];
        for (let i = 0; i < inputRows.length; i++) {
            const row = inputRows[i];
            const next = { ...state };

            if (Array.isArray(row)) {
                for (let j = 0; j < legendNames.length; j++) {
                    const raw = j < row.length ? row[j] : null;
                    if (raw !== null && raw !== undefined) {
                        const value = Number(raw);
                        if (!Number.isFinite(value) || value <= 0) {
                            throw this.makeDKError(`Brain topology row ${i + 1} in '${source}' must contain positive numbers`, {
                                type: "BrainError",
                                code: "BRAIN_INVALID_TOPOLOGY",
                                location: `brain:topology:${source}`
                            });
                        }
                        next[legendNames[j]] = value;
                    }
                }
            } else if (row && typeof row === "object") {
                for (const key of Object.keys(row)) {
                    const normalizedKey = this.normalizeBrainLegendName(key);
                    if (!supportedLegend.has(normalizedKey)) continue;
                    const value = Number(row[key]);
                    if (!Number.isFinite(value) || value <= 0) {
                        throw this.makeDKError(`Brain topology row ${i + 1} in '${source}' must contain positive numbers`, {
                            type: "BrainError",
                            code: "BRAIN_INVALID_TOPOLOGY",
                            location: `brain:topology:${source}`
                        });
                    }
                    next[normalizedKey] = value;
                }
            } else {
                throw this.makeDKError(`Brain topology row ${i + 1} in '${source}' is invalid`, {
                    type: "BrainError",
                    code: "BRAIN_INVALID_TOPOLOGY",
                    location: `brain:topology:${source}`
                });
            }

            if (!Number.isFinite(next.l) || !Number.isFinite(next.h) || !Number.isFinite(next.w)) {
                throw this.makeDKError(`Brain topology row ${i + 1} in '${source}' is incomplete after inheritance`, {
                    type: "BrainError",
                    code: "BRAIN_INVALID_TOPOLOGY",
                    location: `brain:topology:${source}`
                });
            }

            state.l = next.l;
            state.h = next.h;
            state.w = next.w;
            rows.push({
                index: i + 1,
                l: next.l,
                h: next.h,
                w: next.w
            });
        }

        const normalizedEntry = entrySize == null ? null : Number(entrySize);
        const normalizedExit = exitSize == null ? null : Number(exitSize);
        if (normalizedEntry != null && (!Number.isFinite(normalizedEntry) || normalizedEntry <= 0)) {
            throw this.makeDKError(`Brain entry size in '${source}' must be positive`, {
                type: "BrainError",
                code: "BRAIN_INVALID_TOPOLOGY",
                location: `brain:topology:${source}`
            });
        }
        if (normalizedExit != null && (!Number.isFinite(normalizedExit) || normalizedExit <= 0)) {
            throw this.makeDKError(`Brain exit size in '${source}' must be positive`, {
                type: "BrainError",
                code: "BRAIN_INVALID_TOPOLOGY",
                location: `brain:topology:${source}`
            });
        }

        return {
            source,
            sourceLegend: legendNames,
            legend: ["l", "h", "w"],
            rows,
            blocks: rows.map(row => ({
                index: row.index,
                layers: row.l,
                heads: row.h,
                width: row.w
            })),
            rowCount: rows.length,
            totalLayers: rows.reduce((sum, row) => sum + row.l, 0),
            heads: rows.length > 0 ? rows[rows.length - 1].h : null,
            width: rows.length > 0 ? rows[rows.length - 1].w : null,
            entrySize: normalizedEntry,
            exitSize: normalizedExit
        };
    }

    summarizeBrainTopology(topology, legend, entrySize, exitSize) {
        const rows = [];
        const topoLen = this.getArrayLength(topology);
        for (let i = 1; i <= topoLen; i++) rows.push(this.toJSArrayLike(this.getArrayValue(topology, i)));
        return this.makeBrainTopologyPlan(rows, legend, entrySize, exitSize, { source: "runtime" });
    }

    tokenizeBrainText(text) {
        const src = String(text ?? "");
        const matches = src.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g);
        return matches || [];
    }

    applyBrainStop(text, stopPattern) {
        const stops = this.brainToJS(stopPattern);
        if (!Array.isArray(stops) || stops.length === 0) return String(text ?? "");
        let out = String(text ?? "");
        let cut = out.length;
        for (const stop of stops) {
            if (typeof stop !== "string" || stop.length === 0) continue;
            const idx = out.indexOf(stop);
            if (idx !== -1 && idx < cut) cut = idx;
        }
        return out.slice(0, cut);
    }

    getBrainSessionKey(resources, topologyInfo, identityStr, limit, sampleMap) {
        const sample = this.brainToJS(sampleMap);
        return JSON.stringify({
            resources: resources.map(r => [r.kind, r.path]),
            topology: {
                rows: topologyInfo.rowCount,
                layers: topologyInfo.totalLayers,
                heads: topologyInfo.heads,
                width: topologyInfo.width,
                entry: topologyInfo.entrySize,
                exit: topologyInfo.exitSize
            },
            identity: identityStr || "",
            limit: limit ?? null,
            sample: sample || null
        });
    }

    async readBrainRawResource(path) {
        const target = String(path || "");
        if (!target) {
            throw this.makeDKError("Brain resource path is empty", {
                type: "BrainError",
                code: "BRAIN_RESOURCE_MISSING",
                location: "brain:resource"
            });
        }

        if (this.host && typeof this.host.readResource === "function") {
            try {
                return await this.host.readResource(target, {
                    fromPath: this.currentScriptPath,
                    binary: true
                });
            } catch (_) {}
        }

        if (this.MOCK_FS && typeof this.MOCK_FS.read === "function") {
            try {
                const source = this.MOCK_FS.read(target);
                if (source !== null && source !== undefined) return source;
            } catch (_) {}
        }

        if (typeof __dk_window !== "undefined" && typeof __dk_window.fetch === "function") {
            try {
                const response = await __dk_window.fetch(target);
                if (response && response.ok) return new Uint8Array(await response.arrayBuffer());
            } catch (_) {}
        }

        throw this.makeDKError(`Brain resource '${target}' not found`, {
            type: "BrainError",
            code: "BRAIN_RESOURCE_MISSING",
            location: `brain:resource:${target}`
        });
    }

    async readBrainResource(path) {
        const raw = await this.readBrainRawResource(path);
        if (typeof raw === "string") return raw;
        if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
        if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
        return String(raw);
    }

    async readBrainBinaryResource(path) {
        const raw = await this.readBrainRawResource(path);
        if (raw instanceof Uint8Array) return raw;
        if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
        if (typeof raw === "string") return new TextEncoder().encode(raw);
        throw this.makeDKError(`Brain resource '${path}' is not readable as binary`, {
            type: "BrainError",
            code: "BRAIN_RESOURCE_PARSE_ERROR",
            location: `brain:resource:${path}`
        });
    }

    async readBrainJsonResource(path) {
        const raw = await this.readBrainResource(path);
        try {
            return JSON.parse(raw);
        } catch (e) {
            throw this.makeDKError(`Brain resource '${path}' is not valid JSON`, {
                type: "BrainError",
                code: "BRAIN_RESOURCE_PARSE_ERROR",
                location: `brain:resource:${path}`
            });
        }
    }

    normalizeBrainToken(token) {
        return String(token == null ? "" : token).trim().toLowerCase();
    }

    tokenizeBrainFeatures(text) {
        return this.tokenizeBrainText(String(text ?? ""))
            .map(token => this.normalizeBrainToken(token))
            .filter(token => token.length > 0 && /[a-z0-9_]/.test(token));
    }

    trimBrainOutput(text, limit) {
        const normalized = String(text ?? "");
        const maxTokens = Number(limit);
        if (!Number.isFinite(maxTokens) || maxTokens <= 0) return normalized;
        const parts = normalized.trim().length > 0 ? normalized.trim().split(/\s+/) : [];
        if (parts.length <= maxTokens) return normalized;
        return parts.slice(0, Math.floor(maxTokens)).join(" ");
    }

    toDKArray(items, base = 1) {
        const list =
            Array.isArray(items) ? items.slice() :
            ArrayBuffer.isView(items) ? Array.from(items) :
            [];
        if (typeof __dk_window.dkArrayCreate === "function") return __dk_window.dkArrayCreate(list, base);
        const arr = list.slice();
        Object.defineProperty(arr, "__dk_base", {
            value: base,
            writable: true,
            configurable: true,
            enumerable: false
        });
        return arr;
    }

    makeBrainChunk(token, index, done) {
        const chunk = { type: 'arr', data: [null], _base: 1 };
        chunk.data['^token'] = String(token ?? "");
        chunk.data['^index'] = Number(index) || 0;
        chunk.data['^done'] = !!done;
        chunk.data['token'] = String(token ?? "");
        chunk.data['index'] = Number(index) || 0;
        chunk.data['done'] = !!done;
        return chunk;
    }

    resolveBrainJsonKind(doc) {
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "unknown";
        const declared = String(doc.kind || doc.type || "").toLowerCase();
        if (declared === "dk-brain-model" || declared === "brain-model") return "model";
        if (declared === "dk-brain-lm" || declared === "brain-lm" || declared === "dk-brain-autoregressive") return "model";
        if (declared === "dk-brain-vocab" || declared === "brain-vocab") return "vocab";
        if (Array.isArray(doc.classes)) return "model";
        if (doc.backend && typeof doc.backend === "object" && !Array.isArray(doc.backend) && doc.backend.transition) return "model";
        if (Array.isArray(doc.tokens) || (doc.tokens && typeof doc.tokens === "object")) return "vocab";
        return "unknown";
    }

    buildBrainVocab(doc, path) {
        const tokensRaw =
            Array.isArray(doc?.tokens) ? doc.tokens :
            Array.isArray(doc?.vocab) ? doc.vocab :
            null;
        if (!tokensRaw) {
            throw this.makeDKError(`Brain vocab '${path}' is missing a tokens array`, {
                type: "BrainError",
                code: "BRAIN_INVALID_VOCAB",
                location: `brain:resource:${path}`
            });
        }
        const tokens = [];
        const seen = new Set();
        for (const token of tokensRaw) {
            const normalized = this.normalizeBrainToken(token);
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            tokens.push(normalized);
        }
        if (tokens.length === 0) {
            throw this.makeDKError(`Brain vocab '${path}' has no usable tokens`, {
                type: "BrainError",
                code: "BRAIN_INVALID_VOCAB",
                location: `brain:resource:${path}`
            });
        }
        return { path, size: tokens.length, tokens, tokenSet: new Set(tokens), complete: true };
    }

    createLocalBrainModel(config = {}) {
        return {
            path: String(config.path || ""),
            backend: String(config.backend || "local"),
            sourceFormat: String(config.sourceFormat || "unknown"),
            runtimeKind: String(config.runtimeKind || "metadata"),
            executable: !!config.executable,
            resources: Array.isArray(config.resources) ? config.resources.slice() : [],
            vocab: config.vocab || { path: null, size: 0, tokens: [], tokenSet: new Set(), complete: false },
            topology: config.topology || null,
            metadata: config.metadata || {},
            tensorInfo: Array.isArray(config.tensorInfo) ? config.tensorInfo.slice() : [],
            classifier: config.classifier || null,
            lm: config.lm || null,
            diagnostics: config.diagnostics || {}
        };
    }

    getExecutableBrainTopologyContract(topology, vocabSize, path) {
        const rows = Array.isArray(topology?.rows) ? topology.rows : [];
        if (rows.length === 0) {
            throw this.makeDKError(`Brain model '${path}' requires topology rows for executable local generation`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        const firstRow = rows[0] || {};
        const width = Number(firstRow.w);
        const heads = Number(firstRow.h);
        const layers = rows.reduce((sum, row) => sum + Number(row?.l || 0), 0);
        if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(heads) || heads <= 0 || !Number.isInteger(layers) || layers <= 0) {
            throw this.makeDKError(`Brain model '${path}' has invalid executable topology`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        if (width % heads !== 0) {
            throw this.makeDKError(`Brain model '${path}' requires width divisible by heads`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i] || {};
            if (Number(row.w) !== width || Number(row.h) !== heads) {
                throw this.makeDKError(`Brain model '${path}' uses staged topology that this local executable backend cannot honor`, {
                    type: "BrainError",
                    code: "BRAIN_UNSUPPORTED_TOPOLOGY_PLAN",
                    location: `brain:resource:${path}`
                });
            }
        }

        const entrySize = topology?.entrySize == null ? null : Number(topology.entrySize);
        const exitSize = topology?.exitSize == null ? null : Number(topology.exitSize);
        const normalizedVocabSize = Number(vocabSize || 0);
        if (!Number.isInteger(normalizedVocabSize) || normalizedVocabSize <= 0) {
            throw this.makeDKError(`Brain model '${path}' requires a positive vocab size for executable local generation`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        if (entrySize == null || exitSize == null) {
            throw this.makeDKError(`Brain model '${path}' must declare entry and exit for executable local generation`, {
                type: "BrainError",
                code: "BRAIN_UNSUPPORTED_ENTRY_EXIT",
                location: `brain:resource:${path}`
            });
        }
        if (entrySize !== exitSize) {
            throw this.makeDKError(`Brain model '${path}' uses asymmetric entry/exit sizes that this local executable backend cannot honor`, {
                type: "BrainError",
                code: "BRAIN_UNSUPPORTED_ENTRY_EXIT",
                location: `brain:resource:${path}`
            });
        }
        if (entrySize !== normalizedVocabSize || exitSize !== normalizedVocabSize) {
            throw this.makeDKError(`Brain model '${path}' requires entry/exit to match vocab size ${normalizedVocabSize} for executable local generation`, {
                type: "BrainError",
                code: "BRAIN_UNSUPPORTED_ENTRY_EXIT",
                location: `brain:resource:${path}`
            });
        }

        return {
            width,
            heads,
            layers,
            headWidth: Math.floor(width / heads),
            entrySize,
            exitSize,
            vocabSize: normalizedVocabSize
        };
    }

    normalizeBrainFloat(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    expectBrainVector(raw, size, path, label) {
        if (!Array.isArray(raw) || raw.length !== size) {
            throw this.makeDKError(`Brain tensor '${label}' in '${path}' must be a vector of length ${size}`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        const out = new Float32Array(size);
        for (let i = 0; i < size; i++) out[i] = this.normalizeBrainFloat(raw[i], 0);
        return out;
    }

    expectBrainMatrix(raw, rows, cols, path, label) {
        if (!Array.isArray(raw) || raw.length !== rows) {
            throw this.makeDKError(`Brain tensor '${label}' in '${path}' must have ${rows} rows`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        const out = new Float32Array(rows * cols);
        for (let r = 0; r < rows; r++) {
            const row = raw[r];
            if (!Array.isArray(row) || row.length !== cols) {
                throw this.makeDKError(`Brain tensor '${label}' row ${r + 1} in '${path}' must have ${cols} columns`, {
                    type: "BrainError",
                    code: "BRAIN_INVALID_MODEL",
                    location: `brain:resource:${path}`
                });
            }
            for (let c = 0; c < cols; c++) out[r * cols + c] = this.normalizeBrainFloat(row[c], 0);
        }
        return out;
    }

    expectBrainHeadMatrices(raw, heads, headWidth, path, label) {
        if (!Array.isArray(raw) || raw.length !== heads) {
            throw this.makeDKError(`Brain tensor '${label}' in '${path}' must define ${heads} heads`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        const out = new Float32Array(heads * headWidth * headWidth);
        for (let h = 0; h < heads; h++) {
            const matrix = raw[h];
            if (!Array.isArray(matrix) || matrix.length !== headWidth) {
                throw this.makeDKError(`Brain tensor '${label}' head ${h + 1} in '${path}' must have ${headWidth} rows`, {
                    type: "BrainError",
                    code: "BRAIN_INVALID_MODEL",
                    location: `brain:resource:${path}`
                });
            }
            for (let r = 0; r < headWidth; r++) {
                const row = matrix[r];
                if (!Array.isArray(row) || row.length !== headWidth) {
                    throw this.makeDKError(`Brain tensor '${label}' head ${h + 1} row ${r + 1} in '${path}' must have ${headWidth} columns`, {
                        type: "BrainError",
                        code: "BRAIN_INVALID_MODEL",
                        location: `brain:resource:${path}`
                    });
                }
                for (let c = 0; c < headWidth; c++) {
                    const index = (h * headWidth * headWidth) + (r * headWidth) + c;
                    out[index] = this.normalizeBrainFloat(row[c], 0);
                }
            }
        }
        return out;
    }

    parseBrainAutoregressiveBackend(rawBackend, topology, vocabInfo, path, metadata = {}) {
        const backend = rawBackend && typeof rawBackend === "object" && !Array.isArray(rawBackend) ? rawBackend : {};
        const vocabSize = Number(vocabInfo?.size || 0);
        if (vocabSize <= 0) {
            throw this.makeDKError(`Brain model '${path}' requires a usable vocab for local generation`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }

        const shape = this.getExecutableBrainTopologyContract(topology, vocabSize, path);
        const { width, heads, layers, headWidth, entrySize, exitSize } = shape;
        const encoderIn = this.expectBrainMatrix(backend.encoder_in, entrySize, width, path, "encoder_in");
        const startHead = this.expectBrainMatrix(backend.start_head, width, exitSize, path, "start_head");
        const ctxHead = backend.ctx_head ? this.expectBrainMatrix(backend.ctx_head, width, exitSize, path, "ctx_head") : new Float32Array(width * exitSize);
        const transition = this.expectBrainMatrix(backend.transition, exitSize, exitSize, path, "transition");
        const outputBias = backend.output_bias ? this.expectBrainVector(backend.output_bias, exitSize, path, "output_bias") : new Float32Array(exitSize);

        const rawMixers = Array.isArray(backend.mixers) ? backend.mixers : [];
        if (rawMixers.length !== layers) {
            throw this.makeDKError(`Brain model '${path}' requires ${layers} mixer layer(s)`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        const mixers = rawMixers.map((entry, index) => {
            const headWeights = this.expectBrainHeadMatrices(entry?.head_weights, heads, headWidth, path, `mixers.${index + 1}.head_weights`);
            const bias = entry?.bias ? this.expectBrainVector(entry.bias, width, path, `mixers.${index + 1}.bias`) : new Float32Array(width);
            return { headWeights, bias };
        });

        const eosToken = String(backend.eos_token || metadata.eosToken || "<eos>");
        const eosIndex = Array.isArray(vocabInfo?.tokens) ? vocabInfo.tokens.indexOf(this.normalizeBrainToken(eosToken)) : -1;
        return {
            kind: "autoregressive",
            width,
            heads,
            layers,
            headWidth,
            entrySize,
            exitSize,
            encoderIn,
            mixers,
            startHead,
            ctxHead,
            transition,
            outputBias,
            eosToken: this.normalizeBrainToken(eosToken),
            eosId: eosIndex >= 0 ? eosIndex + 1 : null
        };
    }

    buildBrainAutoregressiveModel(doc, path, vocabInfo = null) {
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
            throw this.makeDKError(`Brain model '${path}' must be a JSON object`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }

        const embeddedVocab = !vocabInfo && (Array.isArray(doc.vocab) || Array.isArray(doc.tokens))
            ? this.buildBrainVocab({ tokens: doc.vocab || doc.tokens }, path)
            : null;
        const finalVocab = vocabInfo || embeddedVocab;
        if (!finalVocab) {
            throw this.makeDKError(`Brain model '${path}' requires a vocab JSON or embedded vocab array`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }

        const topology = this.buildBrainModelTopology(doc, path);
        const lm = this.parseBrainAutoregressiveBackend(doc.backend, topology, finalVocab, path, {
            eosToken: doc.eos_token || doc.eosToken || "<eos>"
        });

        return this.createLocalBrainModel({
            path,
            backend: "json-autoregressive",
            sourceFormat: "json",
            runtimeKind: "autoregressive",
            executable: true,
            vocab: finalVocab,
            topology,
            metadata: {
                kind: String(doc.kind || doc.type || "dk-brain-lm"),
                version: Number(doc.version || 1)
            },
            diagnostics: {
                tensorCount: 4 + (lm.mixers.length * 2)
            },
            lm
        });
    }

    buildBrainModel(doc, path, vocabInfo = null) {
        const declared = String(doc?.kind || doc?.type || "").toLowerCase();
        if (declared === "dk-brain-lm" || declared === "brain-lm" || declared === "dk-brain-autoregressive") {
            return this.buildBrainAutoregressiveModel(doc, path, vocabInfo);
        }
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
            throw this.makeDKError(`Brain model '${path}' must be a JSON object`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }

        const embeddedVocab = !vocabInfo && (Array.isArray(doc.vocab) || Array.isArray(doc.tokens))
            ? this.buildBrainVocab({ tokens: doc.vocab || doc.tokens }, path)
            : null;
        const finalVocab = vocabInfo || embeddedVocab;
        if (!finalVocab) {
            throw this.makeDKError(`Brain model '${path}' requires a vocab JSON or embedded vocab array`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }

        const classes = Array.isArray(doc.classes) ? doc.classes : null;
        if (!classes || classes.length === 0) {
            throw this.makeDKError(`Brain model '${path}' requires at least one class`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }

        const normalizedClasses = classes.map((entry, index) => {
            const name = String(entry?.name || `class_${index + 1}`);
            const response = String(entry?.response ?? "");
            if (!response) {
                throw this.makeDKError(`Brain class '${name}' is missing a response`, {
                    type: "BrainError",
                    code: "BRAIN_INVALID_MODEL",
                    location: `brain:model:${name}`
                });
            }
            const bias = Number(entry?.bias ?? 0);
            const weights = entry?.weights;
            if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
                throw this.makeDKError(`Brain class '${name}' is missing a weights map`, {
                    type: "BrainError",
                    code: "BRAIN_INVALID_MODEL",
                    location: `brain:model:${name}`
                });
            }
            const normalizedWeights = {};
            for (const rawKey of Object.keys(weights)) {
                const token = this.normalizeBrainToken(rawKey);
                if (!token) continue;
                const weight = Number(weights[rawKey]);
                if (!Number.isFinite(weight)) continue;
                if (finalVocab.tokenSet.has(token)) normalizedWeights[token] = weight;
            }
            return { name, response, bias: Number.isFinite(bias) ? bias : 0, weights: normalizedWeights };
        });

        const defaultText = String(doc.default_response ?? doc.default?.text ?? "");
        const defaultLabel = String(doc.default_label ?? doc.default?.label ?? "default");
        const topology = this.buildBrainModelTopology(doc, path);
        return this.createLocalBrainModel({
            path,
            backend: "json-classifier",
            sourceFormat: "json",
            runtimeKind: "classifier",
            executable: true,
            vocab: finalVocab,
            topology,
            classifier: {
                classes: normalizedClasses,
                defaultText,
                defaultLabel
            },
            metadata: {
                kind: String(doc.kind || doc.type || "dk-brain-model"),
                version: Number(doc.version || 1)
            }
        });
    }

    buildBrainModelTopology(doc, path) {
        const source = doc?.topology && typeof doc.topology === "object" && !Array.isArray(doc.topology)
            ? doc.topology
            : doc;
        const legendRaw = Array.isArray(source?.legend) ? source.legend : null;
        const legend = legendRaw ? legendRaw.map(v => String(v)) : null;
        const entry = source?.entry ?? source?.entry_size ?? null;
        const exit = source?.exit ?? source?.exit_size ?? null;
        const rowsRaw = Array.isArray(source?.rows) ? source.rows : (Array.isArray(source?.topology_rows) ? source.topology_rows : null);
        if (!legend && entry == null && exit == null && !rowsRaw) return null;

        const rows = [];
        if (rowsRaw) {
            for (const row of rowsRaw) {
                if (!row || typeof row !== "object" || Array.isArray(row)) {
                    throw this.makeDKError(`Brain topology row in '${path}' must be an object`, {
                        type: "BrainError",
                        code: "BRAIN_INVALID_MODEL",
                        location: `brain:resource:${path}`
                    });
                }
                const normalized = {};
                for (const key of Object.keys(row)) {
                    const value = Number(row[key]);
                    if (Number.isFinite(value)) normalized[String(key)] = value;
                }
                rows.push(normalized);
            }
        }

        return this.makeBrainTopologyPlan(rows, legend, entry, exit, { source: path });
    }

    compareBrainTopology(actual, expected) {
        const aLegend = Array.isArray(actual?.legend) ? actual.legend.map(String) : [];
        const eLegend = Array.isArray(expected?.legend) ? expected.legend.map(String) : [];
        if (eLegend.length > 0) {
            if (aLegend.length !== eLegend.length) return false;
            for (let i = 0; i < eLegend.length; i++) {
                if (aLegend[i] !== eLegend[i]) return false;
            }
        }

        if (expected?.entrySize != null && Number(actual?.entrySize ?? null) !== Number(expected.entrySize)) return false;
        if (expected?.exitSize != null && Number(actual?.exitSize ?? null) !== Number(expected.exitSize)) return false;

        const aRows = Array.isArray(actual?.rows) ? actual.rows : [];
        const eRows = Array.isArray(expected?.rows) ? expected.rows : [];
        if (eRows.length > 0) {
            if (aRows.length !== eRows.length) return false;
            for (let i = 0; i < eRows.length; i++) {
                const eRow = eRows[i] || {};
                const aRow = aRows[i] || {};
                for (const key of Object.keys(eRow)) {
                    if (Number(aRow[key]) !== Number(eRow[key])) return false;
                }
            }
        }
        return true;
    }

    compareExecutableBrainContracts(actual, expected) {
        return Number(actual?.layers) === Number(expected?.layers) &&
            Number(actual?.heads) === Number(expected?.heads) &&
            Number(actual?.width) === Number(expected?.width) &&
            Number(actual?.entrySize) === Number(expected?.entrySize) &&
            Number(actual?.exitSize) === Number(expected?.exitSize);
    }

    validateLocalBrainTopology(model, topologyInfo, legend, entrySize, exitSize) {
        const provided =
            !!legend ||
            (Array.isArray(topologyInfo?.rows) && topologyInfo.rows.length > 0) ||
            entrySize != null ||
            exitSize != null;
        const expected = model?.topology || null;
        if (!provided) return expected ? {
            legend: expected.legend || ["l", "h", "w"],
            rows: expected.rows || [],
            rowCount: Array.isArray(expected.rows) ? expected.rows.length : 0,
            totalLayers: Array.isArray(expected.rows) ? expected.rows.reduce((sum, row) => sum + Number(row.l ?? row.layer ?? 0), 0) : 0,
            heads: Array.isArray(expected.rows) && expected.rows.length > 0 ? (expected.rows[expected.rows.length - 1].h ?? expected.rows[expected.rows.length - 1].heads ?? null) : null,
            width: Array.isArray(expected.rows) && expected.rows.length > 0 ? (expected.rows[expected.rows.length - 1].w ?? expected.rows[expected.rows.length - 1].width ?? null) : null,
            entrySize: expected.entrySize ?? null,
            exitSize: expected.exitSize ?? null
        } : topologyInfo;
        if (!expected) {
            throw this.makeDKError("Local brain JSON backend cannot validate topology for this model", {
                type: "BrainError",
                code: "BRAIN_UNSUPPORTED_TOPOLOGY",
                location: "brain:local"
            });
        }
        if (model?.runtimeKind === "autoregressive" && model?.executable) {
            const mergedTopology = {
                ...(expected || {}),
                ...(topologyInfo || {}),
                rows: Array.isArray(topologyInfo?.rows) && topologyInfo.rows.length > 0 ? topologyInfo.rows : (expected?.rows || []),
                entrySize: topologyInfo?.entrySize != null ? topologyInfo.entrySize : expected?.entrySize,
                exitSize: topologyInfo?.exitSize != null ? topologyInfo.exitSize : expected?.exitSize
            };
            const actualContract = this.getExecutableBrainTopologyContract(mergedTopology, Number(model?.vocab?.size || 0), "brain:local");
            const expectedContract = this.getExecutableBrainTopologyContract(expected, Number(model?.vocab?.size || 0), model.path || "brain:model");
            if (!this.compareExecutableBrainContracts(actualContract, expectedContract)) {
                throw this.makeDKError("Local brain topology does not match the executable topology contract for this model", {
                    type: "BrainError",
                    code: "BRAIN_TOPOLOGY_MISMATCH",
                    location: "brain:local"
                });
            }
            return topologyInfo;
        }
        if (!this.compareBrainTopology(topologyInfo, expected)) {
            throw this.makeDKError("Local brain topology does not match model metadata", {
                type: "BrainError",
                code: "BRAIN_TOPOLOGY_MISMATCH",
                location: "brain:local"
            });
        }
        return topologyInfo;
    }

    makeBrainResultHelpers(resultObj, model) {
        const NativeFunction = __dk_window.NativeFunction;
        if (!NativeFunction || !resultObj || !model?.vocab) return;

        const tokenizeFn = new NativeFunction("tokenize", 1, async (text) => {
            return this.toDKArray(this.brainTokenIdsFromText(text, model.vocab), 1);
        });
        const vectorizeFn = new NativeFunction("vectorize", 1, async (text) => {
            if (model.runtimeKind === "autoregressive" && model.lm) {
                return this.toDKArray(this.brainEncodePromptState(String(text ?? ""), model), 1);
            }
            return this.toDKArray(this.brainVectorizeCounts(text, model.vocab), 1);
        });
        const decodeFn = new NativeFunction("decode", 1, async (ids) => {
            return this.decodeBrainTokenIds(this.toJSArrayLike(ids), model.vocab);
        });

        resultObj.data['^tokenize'] = tokenizeFn;
        resultObj.data['^vectorize'] = vectorizeFn;
        resultObj.data['^decode'] = decodeFn;
        resultObj.data['tokenize'] = tokenizeFn;
        resultObj.data['vectorize'] = vectorizeFn;
        resultObj.data['decode'] = decodeFn;
    }

    brainTokenIdsFromText(text, vocab) {
        const ids = [];
        const vocabTokens = Array.isArray(vocab?.tokens) ? vocab.tokens : [];
        const index = new Map();
        for (let i = 0; i < vocabTokens.length; i++) index.set(vocabTokens[i], i + 1);
        for (const token of this.tokenizeBrainFeatures(text)) {
            if (index.has(token)) ids.push(index.get(token));
        }
        return ids;
    }

    brainVectorizeCounts(text, vocab) {
        const tokens = Array.isArray(vocab?.tokens) ? vocab.tokens : [];
        const counts = new Array(tokens.length).fill(0);
        const index = new Map();
        for (let i = 0; i < tokens.length; i++) index.set(tokens[i], i);
        for (const token of this.tokenizeBrainFeatures(text)) {
            const pos = index.get(token);
            if (pos !== undefined) counts[pos] += 1;
        }
        return counts;
    }

    decodeBrainTokenIds(ids, vocab) {
        const tokens = Array.isArray(vocab?.tokens) ? vocab.tokens : [];
        const out = [];
        for (const raw of ids || []) {
            const index = Number(raw);
            if (Number.isInteger(index) && index >= 1 && index <= tokens.length) out.push(tokens[index - 1]);
        }
        return out.join(" ");
    }

    getGGUFTensorTypeName(typeId) {
        const names = {
            0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1",
            8: "Q8_0", 9: "Q8_1", 10: "Q2_K", 11: "Q3_K", 12: "Q4_K", 13: "Q5_K",
            14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS",
            19: "IQ1_S", 20: "IQ4_NL", 21: "IQ3_S", 22: "IQ2_S", 23: "IQ4_XS",
            24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64", 29: "IQ1_M",
            30: "BF16", 31: "Q4_0_4_4", 32: "Q4_0_4_8", 33: "Q4_0_8_8", 34: "TQ1_0",
            35: "TQ2_0"
        };
        return names[typeId] || null;
    }

    parseGGUFFile(bytes, path) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        const decoder = new TextDecoder();

        const ensure = (n) => {
            if (offset + n > view.byteLength) {
                throw this.makeDKError(`GGUF file '${path}' is truncated`, {
                    type: "BrainError",
                    code: "BRAIN_GGUF_PARSE_ERROR",
                    location: `brain:resource:${path}`
                });
            }
        };
        const readU8 = () => { ensure(1); const v = view.getUint8(offset); offset += 1; return v; };
        const readI8 = () => { ensure(1); const v = view.getInt8(offset); offset += 1; return v; };
        const readU16 = () => { ensure(2); const v = view.getUint16(offset, true); offset += 2; return v; };
        const readI16 = () => { ensure(2); const v = view.getInt16(offset, true); offset += 2; return v; };
        const readU32 = () => { ensure(4); const v = view.getUint32(offset, true); offset += 4; return v; };
        const readI32 = () => { ensure(4); const v = view.getInt32(offset, true); offset += 4; return v; };
        const readU64 = () => { ensure(8); const v = Number(view.getBigUint64(offset, true)); offset += 8; return v; };
        const readI64 = () => { ensure(8); const v = Number(view.getBigInt64(offset, true)); offset += 8; return v; };
        const readF32 = () => { ensure(4); const v = view.getFloat32(offset, true); offset += 4; return v; };
        const readF64 = () => { ensure(8); const v = view.getFloat64(offset, true); offset += 8; return v; };
        const readString = () => {
            const len = readU64();
            ensure(len);
            const start = offset;
            offset += len;
            return decoder.decode(new Uint8Array(view.buffer, view.byteOffset + start, len));
        };
        const readValue = (forcedType = null) => {
            const typeId = forcedType == null ? readU32() : forcedType;
            switch (typeId) {
                case 0: return readU8();
                case 1: return readI8();
                case 2: return readU16();
                case 3: return readI16();
                case 4: return readU32();
                case 5: return readI32();
                case 6: return readF32();
                case 7: return readU8() !== 0;
                case 8: return readString();
                case 9: {
                    const elementType = readU32();
                    const count = readU64();
                    const out = [];
                    for (let i = 0; i < count; i++) out.push(readValue(elementType));
                    return out;
                }
                case 10: return readU64();
                case 11: return readI64();
                case 12: return readF64();
                default:
                    throw this.makeDKError(`GGUF metadata value type '${typeId}' is not supported`, {
                        type: "BrainError",
                        code: "BRAIN_GGUF_UNSUPPORTED_VALUE_TYPE",
                        location: `brain:resource:${path}`
                    });
            }
        };

        ensure(4);
        const magic = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset, 4));
        offset += 4;
        if (magic !== "GGUF") {
            throw this.makeDKError(`Brain resource '${path}' is not a GGUF file`, {
                type: "BrainError",
                code: "BRAIN_GGUF_PARSE_ERROR",
                location: `brain:resource:${path}`
            });
        }

        const version = readU32();
        if (version !== 2 && version !== 3) {
            throw this.makeDKError(`GGUF version '${version}' is not supported yet`, {
                type: "BrainError",
                code: "BRAIN_GGUF_UNSUPPORTED_VERSION",
                location: `brain:resource:${path}`
            });
        }

        const tensorCount = readU64();
        const metadataCount = readU64();
        const metadata = {};
        for (let i = 0; i < metadataCount; i++) {
            const key = readString();
            metadata[key] = readValue();
        }

        const tensors = [];
        for (let i = 0; i < tensorCount; i++) {
            const name = readString();
            const nDims = readU32();
            const dims = [];
            for (let d = 0; d < nDims; d++) dims.push(readU64());
            const typeId = readU32();
            const typeName = this.getGGUFTensorTypeName(typeId);
            if (!typeName) {
                throw this.makeDKError(`GGUF tensor type '${typeId}' is not supported`, {
                    type: "BrainError",
                    code: "BRAIN_GGUF_UNSUPPORTED_TENSOR_TYPE",
                    location: `brain:resource:${path}`
                });
            }
            const tensorOffset = readU64();
            tensors.push({ name, dims, typeId, typeName, offset: tensorOffset });
        }

        const alignment = Number(metadata["general.alignment"] || 32);
        const dataOffset = Math.ceil(offset / alignment) * alignment;
        return {
            path,
            version,
            metadata,
            tensorCount,
            alignment,
            tensors: tensors.map(t => ({
                ...t,
                fileOffset: dataOffset + t.offset
            }))
        };
    }

    getGGUFTensorByteSize(typeName, elementCount, path, tensorName) {
        if (typeName === "F32") return elementCount * 4;
        throw this.makeDKError(`GGUF tensor '${tensorName}' in '${path}' uses unsupported executable type '${typeName}'`, {
            type: "BrainError",
            code: "BRAIN_GGUF_UNSUPPORTED_TENSOR_TYPE",
            location: `brain:resource:${path}`
        });
    }

    decodeGGUFTensors(parsed, bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const decoded = {};
        for (const tensor of parsed.tensors || []) {
            const dims = Array.isArray(tensor.dims) ? tensor.dims.map(Number) : [];
            const elementCount = dims.reduce((acc, dim) => acc * Math.max(1, Number(dim) || 1), 1);
            const byteSize = this.getGGUFTensorByteSize(tensor.typeName, elementCount, parsed.path, tensor.name);
            const start = Number(tensor.fileOffset || 0);
            const end = start + byteSize;
            if (start < 0 || end > data.byteLength) {
                throw this.makeDKError(`GGUF tensor '${tensor.name}' in '${parsed.path}' points outside the file`, {
                    type: "BrainError",
                    code: "BRAIN_GGUF_PARSE_ERROR",
                    location: `brain:resource:${parsed.path}`
                });
            }
            if (tensor.typeName === "F32") {
                const values = new Float32Array(elementCount);
                for (let i = 0; i < elementCount; i++) values[i] = view.getFloat32(start + (i * 4), true);
                decoded[tensor.name] = { name: tensor.name, dims, values };
            }
        }
        return decoded;
    }

    expectGGUFTensorVector(tensors, name, size, path) {
        const tensor = tensors[name];
        if (!tensor || tensor.dims.length !== 1 || Number(tensor.dims[0]) !== size) {
            throw this.makeDKError(`GGUF tensor '${name}' in '${path}' must have shape [${size}]`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        return tensor.values;
    }

    expectGGUFTensorMatrix(tensors, name, rows, cols, path) {
        const tensor = tensors[name];
        if (!tensor || tensor.dims.length !== 2 || Number(tensor.dims[0]) !== rows || Number(tensor.dims[1]) !== cols) {
            throw this.makeDKError(`GGUF tensor '${name}' in '${path}' must have shape [${rows}, ${cols}]`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        return tensor.values;
    }

    expectGGUFTensorHeadMatrices(tensors, name, heads, headWidth, path) {
        const tensor = tensors[name];
        if (!tensor || tensor.dims.length !== 3 || Number(tensor.dims[0]) !== heads || Number(tensor.dims[1]) !== headWidth || Number(tensor.dims[2]) !== headWidth) {
            throw this.makeDKError(`GGUF tensor '${name}' in '${path}' must have shape [${heads}, ${headWidth}, ${headWidth}]`, {
                type: "BrainError",
                code: "BRAIN_INVALID_MODEL",
                location: `brain:resource:${path}`
            });
        }
        return tensor.values;
    }

    buildBrainGGUFModel(parsed, path, vocabInfo = null, tensorBytes = null) {
        const meta = parsed.metadata || {};
        const arch = String(meta["general.architecture"] || meta["architecture"] || "unknown");
        const tokenList = Array.isArray(meta["tokenizer.ggml.tokens"]) ? meta["tokenizer.ggml.tokens"] : null;
        const embeddedVocab = !vocabInfo && tokenList ? this.buildBrainVocab({ tokens: tokenList }, path) : null;
        const finalVocab = vocabInfo || embeddedVocab || {
            path,
            size: Number(meta[`${arch}.vocab_size`] || meta["tokenizer.ggml.vocab_size"] || 0),
            tokens: [],
            tokenSet: new Set(),
            complete: false
        };

        const blockCount = Number(meta[`${arch}.block_count`] || meta["dk.topology.block_count"] || 0);
        const headCount = Number(meta[`${arch}.attention.head_count`] || meta["dk.topology.head_count"] || 0);
        const width = Number(meta[`${arch}.embedding_length`] || meta["dk.topology.width"] || 0);
        const entrySize = Number(meta["dk.topology.entry"] || finalVocab.size || 0) || null;
        const exitSize = Number(meta["dk.topology.exit"] || finalVocab.size || 0) || null;
        const topology = (blockCount > 0 && headCount > 0 && width > 0)
            ? this.makeBrainTopologyPlan([{ l: blockCount, h: headCount, w: width }], ["l", "h", "w"], entrySize, exitSize, { source: path })
            : null;

        const runtimeKind = String(meta["dk.brain.kind"] || "").toLowerCase() === "autoregressive" ? "autoregressive" : "metadata";
        if (runtimeKind === "autoregressive") {
            if (!tensorBytes) {
                throw this.makeDKError(`GGUF model '${path}' is missing tensor data`, {
                    type: "BrainError",
                    code: "BRAIN_GGUF_PARSE_ERROR",
                    location: `brain:resource:${path}`
                });
            }
            const tensors = this.decodeGGUFTensors(parsed, tensorBytes);
            const vocabSize = Number(finalVocab?.size || 0);
            const shape = this.getExecutableBrainTopologyContract(topology, vocabSize, path);
            const encoderIn = this.expectGGUFTensorMatrix(tensors, "dk.encoder_in", shape.entrySize, shape.width, path);
            const startHead = this.expectGGUFTensorMatrix(tensors, "dk.start_head", shape.width, shape.exitSize, path);
            const ctxHead = tensors["dk.ctx_head"]
                ? this.expectGGUFTensorMatrix(tensors, "dk.ctx_head", shape.width, shape.exitSize, path)
                : new Float32Array(shape.width * shape.exitSize);
            const transition = this.expectGGUFTensorMatrix(tensors, "dk.transition", shape.exitSize, shape.exitSize, path);
            const outputBias = tensors["dk.output_bias"]
                ? this.expectGGUFTensorVector(tensors, "dk.output_bias", shape.exitSize, path)
                : new Float32Array(shape.exitSize);
            const mixers = [];
            for (let i = 0; i < shape.layers; i++) {
                mixers.push({
                    headWeights: this.expectGGUFTensorHeadMatrices(tensors, `dk.mixer.${i}.head_weights`, shape.heads, shape.headWidth, path),
                    bias: tensors[`dk.mixer.${i}.bias`]
                        ? this.expectGGUFTensorVector(tensors, `dk.mixer.${i}.bias`, shape.width, path)
                        : new Float32Array(shape.width)
                });
            }

            const eosToken = this.normalizeBrainToken(String(meta["dk.brain.eos_token"] || "<eos>"));
            const eosIndex = Array.isArray(finalVocab?.tokens) ? finalVocab.tokens.indexOf(eosToken) : -1;
            return this.createLocalBrainModel({
                path,
                backend: "gguf-autoregressive",
                sourceFormat: "gguf",
                runtimeKind: "autoregressive",
                executable: true,
                vocab: finalVocab,
                topology,
                metadata: {
                    version: parsed.version,
                    architecture: arch,
                    name: String(meta["general.name"] || path),
                    alignment: parsed.alignment,
                    kind: "dk-brain-lm"
                },
                tensorInfo: parsed.tensors,
                diagnostics: {
                    tensorCount: parsed.tensorCount,
                    hasEmbeddedVocab: !!embeddedVocab
                },
                lm: {
                    kind: "autoregressive",
                    width: shape.width,
                    heads: shape.heads,
                    layers: shape.layers,
                    headWidth: shape.headWidth,
                    entrySize: shape.entrySize,
                    exitSize: shape.exitSize,
                    encoderIn,
                    mixers,
                    startHead,
                    ctxHead,
                    transition,
                    outputBias,
                    eosToken,
                    eosId: eosIndex >= 0 ? eosIndex + 1 : null
                }
            });
        }

        return this.createLocalBrainModel({
            path,
            backend: "gguf-metadata",
            sourceFormat: "gguf",
            runtimeKind: "metadata",
            executable: false,
            vocab: finalVocab,
            topology,
            metadata: {
                version: parsed.version,
                architecture: arch,
                name: String(meta["general.name"] || path),
                alignment: parsed.alignment
            },
            tensorInfo: parsed.tensors,
            diagnostics: {
                tensorCount: parsed.tensorCount,
                hasEmbeddedVocab: !!embeddedVocab
            }
        });
    }

    async loadLocalBrainBackend(uses) {
        const resources = Array.isArray(uses) ? uses : [];
        if (resources.length === 0) {
            throw this.makeDKError("Local brain requires at least one local model resource", {
                type: "BrainError",
                code: "BRAIN_RESOURCE_MISSING",
                location: "brain:local"
            });
        }

        let model = null;
        let modelPath = null;
        let vocabDoc = null;
        let vocabPath = null;

        const loadJsonDoc = async (path) => await this.readBrainJsonResource(path);
        const loadGgufDoc = async (path) => {
            const ggufBytes = await this.readBrainBinaryResource(path);
            return { parsed: this.parseGGUFFile(ggufBytes, path), bytes: ggufBytes };
        };
        const getDKErrorCode = (error) => this.getMapValue(error, "code");
        const tryLoadModelByLabel = async (path, label) => {
            const normalizedLabel = String(label || "auto").toLowerCase();
            if (normalizedLabel === "vocab") {
                try {
                    const doc = await loadJsonDoc(path);
                    const kind = this.resolveBrainJsonKind(doc);
                    if (kind !== "vocab") {
                        throw this.makeDKError(`Brain resource '${path}' was labeled vocab but is not a vocab JSON`, {
                            type: "BrainError",
                            code: "BRAIN_INVALID_VOCAB",
                            location: `brain:resource:${path}`
                        });
                    }
                    return { resourceKind: "vocab", doc };
                } catch (e) {
                    const code = getDKErrorCode(e);
                    if (code === "BRAIN_RESOURCE_PARSE_ERROR" || code === "BRAIN_GGUF_PARSE_ERROR") {
                        throw this.makeDKError(`Brain resource '${path}' was labeled vocab but is not a vocab JSON`, {
                            type: "BrainError",
                            code: "BRAIN_INVALID_VOCAB",
                            location: `brain:resource:${path}`
                        });
                    }
                    throw e;
                }
            }

            if (normalizedLabel === "weights") {
                try {
                    const doc = await loadJsonDoc(path);
                    const kind = this.resolveBrainJsonKind(doc);
                    if (kind === "model") return { resourceKind: "model", source: "json", doc, path };
                    if (kind === "vocab") {
                        throw this.makeDKError(`Brain resource '${path}' was labeled weights but is a vocab JSON`, {
                            type: "BrainError",
                            code: "BRAIN_INVALID_MODEL",
                            location: `brain:resource:${path}`
                        });
                    }
                } catch (e) {
                    const code = getDKErrorCode(e);
                    if (code && code !== "BRAIN_RESOURCE_PARSE_ERROR") throw e;
                }

                try {
                    const gguf = await loadGgufDoc(path);
                    return { resourceKind: "model", source: "gguf", parsed: gguf.parsed, bytes: gguf.bytes, path };
                } catch (e) {
                    const code = getDKErrorCode(e);
                    if (code && code !== "BRAIN_RESOURCE_PARSE_ERROR" && code !== "BRAIN_GGUF_PARSE_ERROR") throw e;
                }

                throw this.makeDKError(`Brain weights resource '${path}' is not a supported local JSON or GGUF model`, {
                    type: "BrainError",
                    code: "BRAIN_LOCAL_UNSUPPORTED_FORMAT",
                    location: `brain:resource:${path}`
                });
            }

            return null;
        };

        for (const use of resources) {
            const path = String(use?.path || "");
            const lower = path.toLowerCase();
            const explicit = await tryLoadModelByLabel(path, use?.label);
            if (explicit) {
                if (explicit.resourceKind === "vocab") {
                    if (vocabDoc) {
                        throw this.makeDKError("Local brain supports exactly one vocab JSON", {
                            type: "BrainError",
                            code: "BRAIN_INVALID_VOCAB",
                            location: "brain:local"
                        });
                    }
                    vocabDoc = explicit.doc;
                    vocabPath = path;
                    continue;
                }
                if (model) {
                    throw this.makeDKError("Local brain supports exactly one model resource", {
                        type: "BrainError",
                        code: "BRAIN_INVALID_MODEL",
                        location: "brain:local"
                    });
                }
                model = explicit.source === "gguf"
                    ? { source: "gguf", parsed: explicit.parsed, bytes: explicit.bytes, path }
                    : { source: "json", doc: explicit.doc, path };
                modelPath = path;
                continue;
            }

            if (lower.endsWith(".json")) {
                const doc = await loadJsonDoc(path);
                const kind = this.resolveBrainJsonKind(doc);
                if (kind === "model") {
                    if (model) {
                        throw this.makeDKError("Local brain supports exactly one model resource", {
                            type: "BrainError",
                            code: "BRAIN_INVALID_MODEL",
                            location: "brain:local"
                        });
                    }
                    model = { source: "json", doc, path };
                    modelPath = path;
                } else if (kind === "vocab") {
                    if (vocabDoc) {
                        throw this.makeDKError("Local brain supports exactly one vocab JSON", {
                            type: "BrainError",
                            code: "BRAIN_INVALID_VOCAB",
                            location: "brain:local"
                        });
                    }
                    vocabDoc = doc;
                    vocabPath = path;
                } else {
                    throw this.makeDKError(`Brain JSON '${path}' is neither a model nor vocab document`, {
                        type: "BrainError",
                        code: "BRAIN_INVALID_MODEL",
                        location: `brain:resource:${path}`
                    });
                }
            } else if (lower.endsWith(".gguf")) {
                if (String(use?.label || "auto").toLowerCase() === "vocab") {
                    throw this.makeDKError(`Brain resource '${path}' was labeled vocab but GGUF is only supported as weights`, {
                        type: "BrainError",
                        code: "BRAIN_INVALID_VOCAB",
                        location: `brain:resource:${path}`
                    });
                }
                if (model) {
                    throw this.makeDKError("Local brain supports exactly one model resource", {
                        type: "BrainError",
                        code: "BRAIN_INVALID_MODEL",
                            location: "brain:local"
                    });
                }
                const gguf = await loadGgufDoc(path);
                model = { source: "gguf", parsed: gguf.parsed, bytes: gguf.bytes, path };
                modelPath = path;
            } else {
                throw this.makeDKError(`Local brain does not support '${path}' yet`, {
                    type: "BrainError",
                    code: "BRAIN_LOCAL_UNSUPPORTED_FORMAT",
                    location: `brain:resource:${path}`
                });
            }
        }

        if (!model || !modelPath) {
            throw this.makeDKError("Local brain requires one model resource", {
                type: "BrainError",
                code: "BRAIN_RESOURCE_MISSING",
                location: "brain:local"
            });
        }

        const vocabInfo = vocabDoc ? this.buildBrainVocab(vocabDoc, vocabPath) : null;
        const loadedModel = model.source === "gguf"
            ? this.buildBrainGGUFModel(model.parsed, modelPath, vocabInfo, model.bytes)
            : this.buildBrainModel(model.doc, modelPath, vocabInfo);
        loadedModel.resources = this.getBrainResources(uses);
        return { model: loadedModel, resources: loadedModel.resources };
    }

    scoreLocalBrainModel(model, promptText, options = {}) {
        const memoryState = !!options.memoryState;
        const identityText = String(options.identityText || "");
        const session = options.session || { history: [] };
        const contextParts = [];
        if (identityText) contextParts.push(identityText);
        if (memoryState && Array.isArray(session.history) && session.history.length > 0) {
            contextParts.push(session.history.join(" "));
        }
        contextParts.push(String(promptText ?? ""));
        const classifier = model?.classifier || {};
        const vocab = model?.vocab || { tokenSet: new Set() };
        const featureTokens = this.tokenizeBrainFeatures(contextParts.join(" "));
        const tokenCounts = Object.create(null);
        for (const token of featureTokens) {
            if (!vocab.tokenSet.has(token)) continue;
            tokenCounts[token] = (tokenCounts[token] || 0) + 1;
        }

        const scored = (classifier.classes || []).map((entry, index) => {
            let score = entry.bias;
            for (const token of Object.keys(entry.weights)) {
                score += (tokenCounts[token] || 0) * entry.weights[token];
            }
            return { index, name: entry.name, response: entry.response, score };
        });

        let best = scored[0];
        for (let i = 1; i < scored.length; i++) {
            if (scored[i].score > best.score) best = scored[i];
        }

        const allZero = scored.every(item => item.score <= 0);
        if (allZero && classifier.defaultText) {
            return {
                label: classifier.defaultLabel,
                text: classifier.defaultText,
                confidence: 0,
                reason: "default"
            };
        }

        const maxScore = Math.max(...scored.map(item => item.score));
        const expScores = scored.map(item => Math.exp(item.score - maxScore));
        const expTotal = expScores.reduce((sum, value) => sum + value, 0) || 1;
        const confidence = Number((((expScores[best.index] || 0) / expTotal) * 100).toFixed(2));
        return {
            label: best.name,
            text: best.response,
            confidence,
            reason: "matched"
        };
    }

    getBrainSampleConfig(sampleMap) {
        if (sampleMap == null) return null;
        const allowedKeys = new Set(["temp", "top_p", "top_k", "penalty", "repeat_penalty", "repetition_penalty", "seed"]);
        const sampleKeys = this.getMapKeys(sampleMap);
        for (const key of sampleKeys) {
            if (!allowedKeys.has(String(key))) {
                throw this.makeDKError(`Local brain sample field '${key}' is not supported`, {
                    type: "BrainError",
                    code: "BRAIN_UNSUPPORTED_SAMPLE_FIELD",
                    location: "brain:local"
                });
            }
        }

        const temp = Number(this.getMapValue(sampleMap, "temp"));
        const topP = Number(this.getMapValue(sampleMap, "top_p"));
        const topK = Number(this.getMapValue(sampleMap, "top_k"));
        const seed = Number(this.getMapValue(sampleMap, "seed"));
        const penaltyRaw = [
            this.getMapValue(sampleMap, "penalty"),
            this.getMapValue(sampleMap, "repeat_penalty"),
            this.getMapValue(sampleMap, "repetition_penalty")
        ].filter(value => value != null);
        const cfg = {};
        if (Number.isFinite(temp)) cfg.temp = temp;
        if (Number.isFinite(topP)) {
            if (topP <= 0 || topP > 1) {
                throw this.makeDKError("Local brain sample top_p must be within (0, 1]", {
                    type: "BrainError",
                    code: "BRAIN_INVALID_SAMPLE",
                    location: "brain:local"
                });
            }
            cfg.topP = topP;
        }
        if (Number.isFinite(topK)) {
            if (!Number.isInteger(topK) || topK <= 0) {
                throw this.makeDKError("Local brain sample top_k must be a positive integer", {
                    type: "BrainError",
                    code: "BRAIN_INVALID_SAMPLE",
                    location: "brain:local"
                });
            }
            cfg.topK = topK;
        }
        if (penaltyRaw.length > 0) {
            const penalties = penaltyRaw.map(value => Number(value));
            if (!penalties.every(Number.isFinite) || penalties.some(value => value <= 0)) {
                throw this.makeDKError("Local brain sample penalty must be a positive number", {
                    type: "BrainError",
                    code: "BRAIN_INVALID_SAMPLE",
                    location: "brain:local"
                });
            }
            const firstPenalty = penalties[0];
            if (!penalties.every(value => value === firstPenalty)) {
                throw this.makeDKError("Local brain sample penalty aliases must agree", {
                    type: "BrainError",
                    code: "BRAIN_INVALID_SAMPLE",
                    location: "brain:local"
                });
            }
            cfg.penalty = firstPenalty;
        }
        if (Number.isFinite(seed)) cfg.seed = Math.floor(seed);
        return cfg;
    }

    brainMakePrng(seed) {
        let state = (Number(seed) >>> 0) || 1;
        return () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 4294967296;
        };
    }

    brainVectorMatMul(vector, matrix, rows, cols, out = null) {
        const result = out || new Float32Array(cols);
        result.fill(0);
        for (let r = 0; r < rows; r++) {
            const value = Number(vector[r] || 0);
            if (!value) continue;
            const base = r * cols;
            for (let c = 0; c < cols; c++) result[c] += value * matrix[base + c];
        }
        return result;
    }

    brainApplyMixerLayers(state, lm) {
        let current = new Float32Array(state);
        const { heads, headWidth, width, mixers } = lm;
        for (const mixer of mixers || []) {
            const next = new Float32Array(width);
            const headWeights = mixer.headWeights;
            const bias = mixer.bias || new Float32Array(width);
            for (let h = 0; h < heads; h++) {
                const headOffset = h * headWidth;
                const matrixBase = h * headWidth * headWidth;
                for (let row = 0; row < headWidth; row++) {
                    let total = Number(bias[headOffset + row] || 0);
                    const currentBase = matrixBase + (row * headWidth);
                    for (let col = 0; col < headWidth; col++) {
                        total += Number(current[headOffset + col] || 0) * Number(headWeights[currentBase + col] || 0);
                    }
                    next[headOffset + row] = Math.tanh(total);
                }
            }
            current = next;
        }
        return current;
    }

    brainEncodePromptState(text, model) {
        const lm = model?.lm;
        const vocab = model?.vocab;
        const width = Number(lm?.width || 0);
        const promptIds = this.brainTokenIdsFromText(text, vocab);
        const state = new Float32Array(width);
        for (const rawId of promptIds) {
            const id = Number(rawId);
            if (!Number.isInteger(id) || id < 1) continue;
            const base = (id - 1) * width;
            for (let i = 0; i < width; i++) state[i] += Number(lm.encoderIn[base + i] || 0);
        }
        return this.brainApplyMixerLayers(state, lm);
    }

    brainSelectToken(logits, sampleConfig, historyIds = []) {
        const values = Array.from(logits || [], v => Number(v || 0));
        if (values.length === 0) return { id: null, probability: 0 };

        const penalty = Number(sampleConfig?.penalty);
        if (Number.isFinite(penalty) && penalty > 0 && penalty !== 1 && Array.isArray(historyIds) && historyIds.length > 0) {
            const seen = new Set();
            for (const rawId of historyIds) {
                const id = Number(rawId);
                if (!Number.isInteger(id) || id < 1 || id > values.length || seen.has(id)) continue;
                seen.add(id);
                const index = id - 1;
                values[index] = values[index] >= 0 ? (values[index] / penalty) : (values[index] * penalty);
            }
        }

        const topK = Number(sampleConfig?.topK);
        if (Number.isFinite(topK) && topK > 0 && topK < values.length) {
            const ranked = values
                .map((value, index) => ({ value, index }))
                .sort((a, b) => b.value - a.value)
                .slice(0, topK);
            const keep = new Set(ranked.map(item => item.index));
            for (let i = 0; i < values.length; i++) {
                if (!keep.has(i)) values[i] = Number.NEGATIVE_INFINITY;
            }
        }

        const temp = Number(sampleConfig?.temp);
        if (!Number.isFinite(temp) || temp <= 0) {
            let bestIndex = 0;
            for (let i = 1; i < values.length; i++) {
                if (values[i] > values[bestIndex]) bestIndex = i;
            }
            const maxLogit = values[bestIndex];
            const exps = values.map(v => Math.exp(v - maxLogit));
            const total = exps.reduce((sum, v) => sum + v, 0) || 1;
            return { id: bestIndex + 1, probability: (exps[bestIndex] || 0) / total };
        }

        const scaled = values.map(v => v / temp);
        const maxScaled = Math.max(...scaled);
        let probs = scaled.map(v => Math.exp(v - maxScaled));
        let total = probs.reduce((sum, v) => sum + v, 0) || 1;
        probs = probs.map(v => v / total);

        const topP = Number(sampleConfig?.topP);
        let choices = probs.map((p, index) => ({ index, p }));
        if (Number.isFinite(topP) && topP > 0 && topP < 1) {
            choices.sort((a, b) => b.p - a.p);
            const kept = [];
            let running = 0;
            for (const choice of choices) {
                kept.push(choice);
                running += choice.p;
                if (running >= topP) break;
            }
            const keptTotal = kept.reduce((sum, item) => sum + item.p, 0) || 1;
            choices = kept.map(item => ({ index: item.index, p: item.p / keptTotal }));
        }

        const rand = typeof sampleConfig?.rand === "function"
            ? sampleConfig.rand
            : this.brainMakePrng(Number.isFinite(sampleConfig?.seed) ? sampleConfig.seed : (Date.now() & 0xffffffff));
        const pick = rand();
        let cursor = 0;
        for (const choice of choices) {
            cursor += choice.p;
            if (pick <= cursor) return { id: choice.index + 1, probability: choice.p };
        }
        const fallback = choices[choices.length - 1];
        return { id: fallback.index + 1, probability: fallback.p };
    }

    async generateLocalBrainText(model, promptText, options = {}) {
        const lm = model?.lm;
        const vocab = model?.vocab || { tokens: [] };
        const maxTokens = Number(options.maxTokens || 0);
        const stopPattern = options.stopPattern;
        const sampleConfig = options.sampleConfig ? { ...options.sampleConfig } : null;
        const emitChunk = typeof options.emitChunk === "function" ? options.emitChunk : null;
        if (sampleConfig && typeof sampleConfig.rand !== "function") {
            sampleConfig.rand = this.brainMakePrng(Number.isFinite(sampleConfig.seed) ? sampleConfig.seed : (Date.now() & 0xffffffff));
        }
        const promptState = this.brainEncodePromptState(promptText, model);
        const startLogits = this.brainVectorMatMul(promptState, lm.startHead, lm.width, vocab.size, new Float32Array(vocab.size));
        for (let i = 0; i < vocab.size; i++) startLogits[i] += Number(lm.outputBias[i] || 0);

        const outputIds = [];
        const probabilities = [];
        const chunks = [];
        let logits = startLogits;
        let finalText = "";
        let stoppedBy = "limit";
        let emittedCount = 0;
        let pendingToken = null;
        let pendingIndex = 0;

        const flushPendingChunk = async (done) => {
            if (pendingToken == null) return;
            const chunk = this.makeBrainChunk(pendingToken, pendingIndex, done);
            chunks.push(chunk);
            pendingToken = null;
            pendingIndex = 0;
            if (emitChunk) await emitChunk(chunk);
        };

        const stageVisibleTokens = async (text) => {
            const visibleTokens = this.tokenizeBrainText(text);
            while (emittedCount < visibleTokens.length) {
                const token = visibleTokens[emittedCount];
                emittedCount += 1;
                if (pendingToken != null) await flushPendingChunk(false);
                pendingToken = token;
                pendingIndex = emittedCount;
            }
        };

        for (let step = 0; step < maxTokens; step++) {
            const selected = this.brainSelectToken(logits, sampleConfig, outputIds);
            if (!selected.id) break;
            if (lm.eosId && selected.id === lm.eosId) {
                stoppedBy = "eos";
                break;
            }

            outputIds.push(selected.id);
            probabilities.push(Number(selected.probability || 0));
            finalText = this.decodeBrainTokenIds(outputIds, vocab);
            const stoppedText = this.applyBrainStop(finalText, stopPattern);
            if (stoppedText !== finalText) {
                finalText = stoppedText;
                await stageVisibleTokens(finalText);
                stoppedBy = "stop";
                break;
            }
            await stageVisibleTokens(finalText);

            const nextLogits = this.brainVectorMatMul(promptState, lm.ctxHead, lm.width, vocab.size, new Float32Array(vocab.size));
            const transitionBase = (selected.id - 1) * vocab.size;
            for (let i = 0; i < vocab.size; i++) {
                nextLogits[i] += Number(lm.transition[transitionBase + i] || 0) + Number(lm.outputBias[i] || 0);
            }
            logits = nextLogits;
            stoppedBy = "limit";
        }

        await flushPendingChunk(true);

        const avgProb = probabilities.length > 0
            ? probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length
            : 0;
        return {
            text: finalText,
            confidence: Number((avgProb * 100).toFixed(2)),
            reason: "generated",
            label: "generated",
            tokens: this.tokenizeBrainText(finalText).length,
            stopReason: stoppedBy,
            vector: Array.from(promptState),
            chunks
        };
    }

    makeBrainUnavailableError(mode, details = {}) {
        const normalizedMode = String(mode || "local").toLowerCase() === "cloud" ? "cloud" : "local";
        const code = normalizedMode === "cloud" ? "BRAIN_CLOUD_UNAVAILABLE" : "BRAIN_LOCAL_UNAVAILABLE";
        const location = normalizedMode === "cloud" ? "brain:cloud" : "brain:local";
        const reason =
            normalizedMode === "cloud"
                ? "Cloud brain provider integration is not implemented in this runtime"
                : "Local brain runtime is not implemented in this host";
        const suffix = details.summary ? ` (${details.summary})` : "";
        return this.makeDKError(`${reason}${suffix}`, {
            type: "BrainError",
            code,
            location
        });
    }

    toJSArrayLike(val) {
        if (val == null) return [];
        if (Array.isArray(val)) return val.slice();
        const out = [];
        const len = this.getArrayLength(val);
        for (let i = 1; i <= len; i++) out.push(this.getArrayValue(val, i));
        return out;
    }

    getSolverDomainChoices(domainMap, names) {
        const out = [];
        for (const name of names || []) {
            const raw = this.getMapValue(domainMap, name);
            const isArrayLike =
                raw == null ||
                Array.isArray(raw) ||
                this.isDKArray(raw) ||
                this.isDKWrapper(raw) ||
                ArrayBuffer.isView(raw);
            if (!isArrayLike) {
                throw this.makeDKError(`Solver domain '${name}' must be array-like`, {
                    type: "SolverError",
                    code: "SOLVER_DOMAIN_ERROR",
                    location: `solver.domain.${name}`
                });
            }
            out.push(this.toJSArrayLike(raw));
        }
        return out;
    }

    makeSolverSolution(assignments) {
        const out = { type: 'arr', data: [null], _base: 1 };
        for (const key of Object.keys(assignments || {})) {
            out.data['^' + key] = assignments[key];
            out.data[key] = assignments[key];
        }
        return out;
    }

    flattenSolverClosures(value) {
        const top = this.toJSArrayLike(value);
        const flat = [];
        for (const item of top) {
            const nested = this.toJSArrayLike(item);
            if (Array.isArray(nested) && nested.length > 0) {
                for (const inner of nested) flat.push(inner);
            } else {
                flat.push(item);
            }
        }
        return flat;
    }

    makeSolverResult(fields) {
        const out = { type: 'arr', data: [null], _base: 1 };
        for (const [key, value] of Object.entries(fields || {})) {
            const dkVal = (value && typeof value === 'object' && !this.isDKWrapper(value) && !this.isDKArray(value) && !ArrayBuffer.isView(value))
                ? this.toDKFlagValue(value)
                : value;
            out.data['^' + key] = dkVal;
            out.data[key] = dkVal;
        }
        return out;
    }

    compareSolverScores(a, b) {
        if (!a && !b) return 0;
        if (!a) return -1;
        if (!b) return 1;
        if ((a.hard || 0) !== (b.hard || 0)) return (a.hard || 0) > (b.hard || 0) ? 1 : -1;
        if ((a.soft || 0) !== (b.soft || 0)) return (a.soft || 0) > (b.soft || 0) ? 1 : -1;
        const aObj = Array.isArray(a.objectives) ? a.objectives : [];
        const bObj = Array.isArray(b.objectives) ? b.objectives : [];
        const len = Math.max(aObj.length, bObj.length);
        for (let i = 0; i < len; i++) {
            const av = Number(aObj[i] ?? 0);
            const bv = Number(bObj[i] ?? 0);
            if (av !== bv) return av > bv ? 1 : -1;
        }
        return 0;
    }

    isSolverCallable(val) {
        return val instanceof __dk_window.ObjClosure || val instanceof __dk_window.NativeFunction;
    }

    pushValue(val) {
        if (this.debug && this.sp >= this.stackSize) {
            throw new Error(`Stack overflow on push (sp=${this.sp}, size=${this.stackSize})`);
        }
        this.setStack(this.sp++, val);
    }

    popValue() {
        if (this.sp <= this.bp) {
            throw new Error(`Stack underflow on pop (sp=${this.sp}, bp=${this.bp})`);
        }
        const idx = --this.sp;
        const v = this.stack[idx];
        if (this.clearOnPop) this.stack[idx] = null;
        this.numMask[idx] = 0;
        return v;
    }

    setStack(idx, val) {
        this.stack[idx] = val;
        if (typeof val === "number" && Number.isFinite(val)) {
            this.numStack[idx] = val;
            this.numMask[idx] = 1;
        } else {
            this.numMask[idx] = 0;
        }
    }

    dumpStack(errorMsg, isFatal = true) {
        let crashLine = "Unknown";
    if (this.frameCount > 0) {
        const frame = this.frames[this.frameCount - 1];
        // FIX: Use the VM's active 'this.ip' which is updated every tick
        const crashedIp = this.ip - 1; 
        crashLine = frame.closure.function.codeLines[crashedIp] || "Unknown";
    }

        this.logger(`<div style='color:red; font-weight:bold;'>
            [CRASH] ${errorMsg} <br>
            at Line: ${crashLine}
        </div>`);
        const stackSlice = this.stack.slice(0, this.sp).map((v, i) => {
            const val = this.stringify(v);
            const marker = (i === this.bp) ? " <span style='color:cyan'>[BP]</span>" : "";
            return `<div style='font-family:monospace; font-size:12px; border-bottom:1px solid #333'>[${String(i).padStart(3, '0')}] ${val}${marker}</div>`;
        });
        
        const color = isFatal ? "red" : "orange";
        const title = isFatal ? "CRASH DUMP" : "NON-FATAL ERROR";
        const lastOpName = this.lastOpName || "unknown";
        const lastOpIp = (this.lastOpIp !== undefined && this.lastOpIp !== null) ? this.lastOpIp : "?";
        const lastOpCode = (this.lastOpCode !== undefined && this.lastOpCode !== null) ? this.lastOpCode : "?";
        const callMeta = (this.lastCallArgCount !== undefined)
            ? ` | CallArgs:${this.lastCallArgCount} Callee:${this.stringify(this.lastCalleeVal)}`
            : "";
        const invokeMeta = (this.lastInvokeArgCount !== undefined)
            ? ` | InvokeArgs:${this.lastInvokeArgCount} Receiver:${this.stringify(this.lastInvokeReceiver)} Method:${this.lastInvokeMethodName}`
            : "";

        let codeHtml = "";
        if (this.frames && this.frameCount > 0) {
            const cur = this.frames[this.frameCount - 1];
            const code = cur?.closure?.function?.code;
            if (Array.isArray(code)) {
                const ip = this.ip || 0;
                const start = Math.max(0, ip - 20);
                const end = Math.min(code.length, ip + 20);
                const bytes = [];
                for (let i = start; i < end; i++) {
                    const b = code[i];
                    const mark = (i === ip) ? ">>" : "  ";
                    bytes.push(`${mark}${String(i).padStart(4, '0')}:${String(b).padStart(3, ' ')}`);
                }
                const fnName = cur?.closure?.function?.name || "<anon>";
                codeHtml = `<div style='font-family:monospace; font-size:11px; margin-bottom:5px; color:#888'>
                Bytecode window for ${fnName} (ip:${ip}):<br>
                ${bytes.join("<br>")}
            </div>`;
            }
        }

        const traceHtml = (this.opTrace && this.opTrace.length > 0)
            ? `<div style='font-family:monospace; font-size:11px; color:#aaa; margin-top:6px'>
                <div style='margin-bottom:4px'>Last ${this.opTrace.length} ops (oldest → newest):</div>
                ${this.opTrace.map(t =>
                    `<div>[${String(t.idx).padStart(2, '0')}] IP:${t.ip} ${t.opName} (${t.opCode}) SP:${t.preSp}→${t.postSp} BP:${t.preBp}→${t.postBp}</div>`
                ).join('')}
               </div>`
            : "";

        let framesHtml = "";
        if (this.frames && this.frameCount > 0) {
            const maxFrames = 6;
            const start = Math.max(0, this.frameCount - maxFrames);
            framesHtml = `<div style='font-family:monospace; font-size:11px; margin-bottom:5px; color:#888'>
                Frames (oldest → newest):<br>
                ${this.frames.slice(start, this.frameCount).map((f, i) => {
                    const idx = start + i;
                    const name = f?.closure?.function?.name || "<anon>";
                    return `[#${idx}] ${name} | bp:${f.bp} ip:${f.ip}`;
                }).join("<br>")}
            </div>`;
        }

        const html = `
            <div style='background:#222; color:#eee; padding:10px; border:2px solid ${color}; margin-top:10px'>
                <strong style='color:${color}'>${title}: ${errorMsg}</strong><br>
                <div style='font-family:monospace; font-size:11px; margin-bottom:5px; color:#888'>
                    IP:${this.ip} SP:${this.sp} BP:${this.bp} | LastOp:${lastOpName} (${lastOpCode}) @ ${lastOpIp}${callMeta}${invokeMeta}
                </div>
                ${framesHtml}
                ${codeHtml}
                <div style='max-height:100px; overflow-y:auto; border:1px solid #444; background:#111; padding:5px'>
                    ${stackSlice.join('')}
                </div>
                ${traceHtml}
            </div>`;
        
        if (this.logger) this.logger(html);
        else console.error(errorMsg);
    }

    trace(op, code, ip, constants) {
        if (!this.traceExecution) return;
        const OP_NAMES = __dk_window.OP_NAMES || {};
        const opName = OP_NAMES[op] || "OP_" + op;
        console.log(`[VM] IP:${ip} | ${opName} | SP:${this.sp}`);
    }

    isDKArray(val) {
        if (!Array.isArray(val)) return false;
        if (typeof __dk_window.dkArrayEnsure === "function") {
            __dk_window.dkArrayEnsure(val);
        }
        return true;
    }

    isDKWrapper(val) {
        return !!(val && val.type === "arr");
    }

    isStringView(val) {
        return !!(val && val.type === "strview");
    }

    // NOTE: getBufferBase is DELETED. All buffers/vectors go through getArrayBase now.

    getArrayBase(val) {
        // Unified check for standard arrays AND memory vectors
        if (this.isDKArray(val) || ArrayBuffer.isView(val)) {
            if (typeof __dk_window.dkArrayBaseGet === "function") {
                return __dk_window.dkArrayBaseGet(val);
            }
            if (typeof val.__dk_base === "number") return val.__dk_base;
            return 1;
        }
        if (this.isDKWrapper(val)) return (val._base !== undefined && val._base !== null) ? val._base : 1;
        return 1;
    }

    setArrayBase(val, base) {
        if (this.isDKArray(val) || ArrayBuffer.isView(val)) {
            if (typeof __dk_window.dkArrayBaseSet === "function") {
                __dk_window.dkArrayBaseSet(val, base);
            } else {
                Object.defineProperty(val, "__dk_base", { value: Number(base) || 1, writable: true, configurable: true, enumerable: false });
            }
            return;
        }
        if (this.isDKWrapper(val)) { val._base = Number(base); return; }
    }

    getDKArrayMeta(arr) {
        if (!Array.isArray(arr)) return null;
        if (typeof __dk_window.dkArrayEnsure === "function") {
            return __dk_window.dkArrayEnsure(arr);
        }
        if (!arr.__dk_meta) {
            Object.defineProperty(arr, "__dk_meta", {
                value: { base: 1, hybridKeys: [] },
                writable: true,
                configurable: true,
                enumerable: false
            });
        }
        if (!Array.isArray(arr.__dk_meta.hybridKeys)) arr.__dk_meta.hybridKeys = [];
        return arr.__dk_meta;
    }

    getHybridKeySlots(arr) {
        const meta = this.getDKArrayMeta(arr);
        if (!meta) return null;
        if (!Array.isArray(meta.hybridKeys)) meta.hybridKeys = [];
        while (meta.hybridKeys.length < arr.length) meta.hybridKeys.push(null);
        if (meta.hybridKeys.length > arr.length) meta.hybridKeys.length = arr.length;
        return meta.hybridKeys;
    }

    copyHybridKeySlots(source, dest, start = 0, end = null) {
        if (!this.isDKArray(dest)) return;
        const destSlots = this.getHybridKeySlots(dest);
        destSlots.length = 0;
        if (!this.isDKArray(source)) {
            while (destSlots.length < dest.length) destSlots.push(null);
            return;
        }
        const sourceSlots = this.getHybridKeySlots(source);
        const sliceEnd = end === null || end === undefined ? source.length : Number(end);
        destSlots.push(...sourceSlots.slice(Number(start) || 0, sliceEnd));
        while (destSlots.length < dest.length) destSlots.push(null);
    }

    normalizeHybridKey(key) {
        const raw = String(key);
        return raw.startsWith("^") ? raw.slice(1) : raw;
    }

    getHybridEntries(arr) {
        if (!this.isDKArray(arr)) return [];
        const slots = this.getHybridKeySlots(arr);
        const entries = [];
        for (let i = 0; i < arr.length; i++) {
            if (slots[i] === null || slots[i] === undefined) continue;
            entries.push({ key: String(slots[i]), value: arr[i], rawIndex: i });
        }
        return entries;
    }

    appendHybridValue(arr, value, key = null) {
        if (!this.isDKArray(arr)) return value;
        arr.push(value);
        const slots = this.getHybridKeySlots(arr);
        slots[arr.length - 1] = (key === null || key === undefined) ? null : this.normalizeHybridKey(key);
        return value;
    }

    aliasHybridSlot(arr, key, index) {
        if (!this.isDKArray(arr)) return;
        const base = this.getArrayBase(arr);
        const rawIndex = Number(index) - base;
        if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= arr.length) return;
        const slots = this.getHybridKeySlots(arr);
        slots[rawIndex] = this.normalizeHybridKey(key);
    }

    removeHybridEntry(arr, key) {
        if (!this.isDKArray(arr)) return null;
        const wanted = this.normalizeHybridKey(key);
        const slots = this.getHybridKeySlots(arr);
        const rawIndex = slots.findIndex(slot => slot === wanted);
        if (rawIndex === -1) return null;
        slots.splice(rawIndex, 1);
        return arr.splice(rawIndex, 1)[0];
    }

    getIndexWithBase(index, base) {
        const idx = Number(index);
        const b = Number(base);
        if (!Number.isFinite(idx) || !Number.isFinite(b)) return NaN;
        return idx - b;
    }

    getArrayValueAtBase(val, index, baseOverride = null) {
        const base = (baseOverride === null || baseOverride === undefined) ? this.getArrayBase(val) : Number(baseOverride);
        const idx = Number(index);
        if (this.isDKArray(val) || ArrayBuffer.isView(val)) return val[idx - base];
        if (this.isDKWrapper(val)) return val.data[idx - base + 1];
        return null;
    }

    setArrayValueAtBase(val, index, item, baseOverride = null) {
        const base = (baseOverride === null || baseOverride === undefined) ? this.getArrayBase(val) : Number(baseOverride);
        const idx = Number(index);
        if (ArrayBuffer.isView(val)) { val[idx - base] = item; return; }
        if (this.isDKArray(val)) { val[idx - base] = item; this.getHybridKeySlots(val); return; }
        if (this.isDKWrapper(val)) { val.data[idx - base + 1] = item; }
    }

    getArrayLength(val) {
        if (this.isDKArray(val) || ArrayBuffer.isView(val)) return val.length;
        if (this.isDKWrapper(val)) return val.data.length - this.getArrayBase(val);
        return 0;
    }

    getArrayValue(val, index) {
        const base = this.getArrayBase(val);
        const idx = Number(index);
        if (ArrayBuffer.isView(val)) {
            return val[idx - base];
        }
        if (this.isDKArray(val)) {
            return val[idx - base];
        }
        if (this.isDKWrapper(val)) {
            return val.data[idx - base + 1];
        }
        return null;
    }

    setArrayValue(val, index, item) {
        const base = this.getArrayBase(val);
        const idx = Number(index);
        if (ArrayBuffer.isView(val)) {
            val[idx - base] = item;
            return;
        }
        if (this.isDKArray(val)) {
            val[idx - base] = item;
            this.getHybridKeySlots(val);
            return;
        }
        if (this.isDKWrapper(val)) {
            val.data[idx - base + 1] = item;
        }
    }

    normalizeMapKey(key) {
        const raw = String(key);
        return raw.startsWith("^") ? raw : ("^" + raw);
    }

    getMapValue(target, key) {
        const internal = this.normalizeMapKey(key);
        if (this.isDKWrapper(target)) {
            return target.data[internal] ?? target.data[key];
        }
        if (this.isDKArray(target)) {
            const wanted = this.normalizeHybridKey(key);
            const matches = this.getHybridEntries(target)
                .filter(entry => entry.key === wanted)
                .map(entry => entry.value);
            if (matches.length === 0) return null;
            return this.toDKArray(matches, 1);
        }
        return null;
    }

    setMapValue(target, key, value) {
        const internal = this.normalizeMapKey(key);
        if (this.isDKWrapper(target)) {
            target.data[internal] = value;
            return;
        }
        if (this.isDKArray(target)) {
            this.appendHybridValue(target, value, key);
        }
    }

    hasMapKey(target, key) {
        const internal = this.normalizeMapKey(key);
        if (this.isDKWrapper(target)) {
            return Object.prototype.hasOwnProperty.call(target.data, internal) ||
                Object.prototype.hasOwnProperty.call(target.data, key);
        }
        if (this.isDKArray(target)) {
            const wanted = this.normalizeHybridKey(key);
            return this.getHybridEntries(target).some(entry => entry.key === wanted);
        }
        return false;
    }

    isAppendableAccumulationValue(value) {
        if (this.isDKArray(value)) return true;
        if (this.isDKWrapper(value)) return value._isMap !== true;
        return false;
    }

    appendAccumulationValue(target, value) {
        if (this.isDKArray(target)) {
            target.push(value);
            return target;
        }
        if (this.isDKWrapper(target) && target._isMap !== true) {
            target.data.push(value);
            return target;
        }
        return this.toDKArray([target, value], 1);
    }

    accumulateMapValue(current, incoming) {
        if (this.isAppendableAccumulationValue(current)) {
            return this.appendAccumulationValue(current, incoming);
        }
        return this.toDKArray([current, incoming], 1);
    }

    mergeCollectionInto(dest, source) {
        const destIsCollection = this.isDKWrapper(dest) || this.isDKArray(dest);
        const sourceIsCollection = this.isDKWrapper(source) || this.isDKArray(source);
        if (!destIsCollection || !sourceIsCollection) return false;

        if (this.isDKArray(dest)) {
            if (this.isDKArray(source)) {
                const sourceSlots = this.getHybridKeySlots(source).slice();
                for (let i = 0; i < source.length; i++) {
                    this.appendHybridValue(dest, source[i], sourceSlots[i]);
                }
                return true;
            }
            const sourceBase = this.getArrayBase(source);
            for (let i = sourceBase; i < source.data.length; i++) {
                this.appendHybridValue(dest, source.data[i], null);
            }
            for (const entry of this.getMapEntries(source)) {
                this.appendHybridValue(dest, entry.value, entry.key);
            }
            return true;
        }

        const sourceLen = this.getArrayLength(source);
        for (let i = 0; i < sourceLen; i++) {
            const item = this.getArrayValue(source, this.getArrayBase(source) + i);
            if (this.isDKWrapper(dest)) dest.data.push(item);
            else dest.push(item);
        }

        for (const entry of this.getMapEntries(source)) {
            const key = entry.key;
            const incoming = entry.value;
            if (this.hasMapKey(dest, key)) {
                const current = this.getMapValue(dest, key);
                this.setMapValue(dest, key, this.accumulateMapValue(current, incoming));
            } else {
                this.setMapValue(dest, key, incoming);
            }
        }
        return true;
    }

    getMapEntries(target) {
        if (this.isDKWrapper(target)) {
            return Object.keys(target.data)
                .filter(k => k.startsWith("^"))
                .map(k => ({ key: k.substring(1), value: target.data[k] }));
        }
        if (this.isDKArray(target)) {
            return this.getHybridEntries(target).map(entry => ({ key: entry.key, value: entry.value }));
        }
        return [];
    }

    getMapKeys(target) {
        return this.getMapEntries(target).map(entry => entry.key);
    }

    getMapValues(target) {
        return this.getMapEntries(target).map(entry => entry.value);
    }

    formatMapKeyForStringify(key) {
        const raw = String(key ?? "");
        return /^[A-Za-z0-9_]+$/.test(raw) ? `^${raw}` : `^${JSON.stringify(raw)}`;
    }

    getStringifyMapParts(target, seen) {
        const parts = [];
        for (const entry of this.getMapEntries(target)) {
            parts.push(`${this.formatMapKeyForStringify(entry.key)}: ${this.stringify(entry.value, seen)}`);
        }
        return parts;
    }

    stringify(val, seen = new Set()) {
        if (val === null) return "null"; 
        if (val === true) return "true"; 
        if (val === false) return "false";

        // Intercept function references during string coercion
        if (val instanceof __dk_window.ObjClosure || val instanceof __dk_window.ObjFunction || val instanceof __dk_window.NativeFunction) {
            return "null";
        }

        if (val instanceof __dk_window.ObjInstance) return `[Instance: ${val.klass?.name || "?"}]`;
        if (val instanceof __dk_window.ObjClass) return `[Class: ${val.name || "?"}]`;

        if (ArrayBuffer.isView(val)) {
            let s = "|[";
            for (let i = 0; i < val.length; i++) {
                // If it's NaN, format it back as the 'any' keyword for readability
                let v = val[i];
                let strV = Number.isNaN(v) ? "any" : String(v);
                s += (i > 0 ? ", " : "") + strV;
            }
            return s + "]";
        }
        
        if (this.isDKArray(val)) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
            const slots = this.getHybridKeySlots(val);
            const parts = [];
            for (let i = 0; i < val.length; i++) {
                const rendered = this.stringify(val[i], seen);
                if (slots[i] === null || slots[i] === undefined) parts.push(rendered);
                else parts.push(`${this.formatMapKeyForStringify(slots[i])}: ${rendered}`);
            }
            const rendered = `[${parts.join(", ")}]`;
            seen.delete(val);
            return rendered;
        }

        if (this.isDKWrapper(val)) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
            if (val._classRef) { seen.delete(val); return `[Instance: ${val._classRef}]`; }
            const parts = [];
            const base = this.getArrayBase(val);
            for(let i = base; i < val.data.length; i++) { 
                parts.push(this.stringify(val.data[i], seen));
            }
            const rendered = `[${parts.concat(this.getStringifyMapParts(val, seen)).join(", ")}]`;
            seen.delete(val); 
            return rendered;
        }

        if (this.isStringView(val)) {
            return String(val.text ?? "");
        }
        
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
    }
    
loadModule(path) {
    this.logger(`[VM] loadModule: Loading "${path}"`);

    const LexerCtor =
        this.Lexer ||
        ((typeof Lexer !== "undefined") ? Lexer : null) ||
        ((typeof __dk_window !== "undefined" && __dk_window.Lexer) ? __dk_window.Lexer : null);
    const ParserCtor =
        this.Parser ||
        ((typeof Parser !== "undefined") ? Parser : null) ||
        ((typeof __dk_window !== "undefined" && __dk_window.Parser) ? __dk_window.Parser : null);
    const CompilerCtor =
        this.Compiler ||
        ((typeof Compiler !== "undefined") ? Compiler : null) ||
        ((typeof __dk_window !== "undefined" && __dk_window.Compiler) ? __dk_window.Compiler : null);

    if (!LexerCtor || !ParserCtor || !CompilerCtor) {
        throw this.makeDKError("Module system is unavailable in this host", {
            type: "HostError",
            code: "MODULE_UNAVAILABLE",
            location: `import:${String(path || "")}`
        });
    }

    let source = null;
    let resolvedPath = String(path || "");
    if (this.host && typeof this.host.loadModuleSource === "function") {
        try {
            const loaded = this.host.loadModuleSource(path, {
                fromPath: this.currentScriptPath
            });
            source = loaded && loaded.source;
            resolvedPath = loaded && loaded.path ? loaded.path : resolvedPath;
        } catch (error) {
            throw this.makeDKError(String(error.message || error), {
                type: "ModuleError",
                code: "MODULE_NOT_FOUND",
                location: `import:${String(path || "")}`
            });
        }
    } else {
        if (!this.MOCK_FS || typeof this.MOCK_FS.read !== 'function') {
            throw this.makeDKError("Module system not initialized in this host", {
                type: "HostError",
                code: "MODULE_UNAVAILABLE",
                location: `import:${String(path || "")}`
            });
        }
        try {
            source = this.MOCK_FS.read(path);
        } catch (error) {
            throw this.makeDKError(String(error.message || error), {
                type: "ModuleError",
                code: "MODULE_NOT_FOUND",
                location: `import:${String(path || "")}`
            });
        }
    }
    if (!source) {
        throw this.makeDKError(`Module '${path}' not found`, {
            type: "ModuleError",
            code: "MODULE_NOT_FOUND",
            location: `import:${String(path || "")}`
        });
    }

    try {
        const lexer = new LexerCtor(source);
        const tokens = lexer.tokenize();
        const parser = new ParserCtor(tokens, this.logger);
        const ast = parser.parse();
        
        const compiler = new CompilerCtor(this.logger);
        // We pass 'true' so the compiler uses global scope for assignments
        const moduleFunc = compiler.compile(ast, true); 

        const moduleVM = new VM(this.logger);
        moduleVM.MOCK_FS = this.MOCK_FS;
        moduleVM.host = this.host;
        moduleVM.currentScriptPath = resolvedPath;
        moduleVM.Lexer = LexerCtor;
        moduleVM.Parser = ParserCtor;
        moduleVM.Compiler = CompilerCtor;
        moduleVM.Minifier = this.Minifier;
        moduleVM.setDKPSigils(this.getDKPSigilList(), "import:sigils");

        // Snapshot native globals before module execution so we only export
        // symbols introduced by the module itself.
        const moduleNativeKeys = new Set(moduleVM.globals.keys());
        
        moduleVM.setRuntimeFlags(this.globals.get("__dk_flags"));
        moduleVM.interpret(moduleFunc);
        if (moduleVM.globals.has("in") || moduleVM.globalFunctions.has("in")) {
            moduleVM.invokeGlobal("in", [moduleVM.globals.get("__dk_flags")]);
        }

        // Core DK Map Structure: An array wrapper with named keys
        const exports = { type: 'arr', data: [null], _base: 1, _isModule: true };
        
        // Export standard globals
        for (let [key, value] of moduleVM.globals) {
            if (!moduleNativeKeys.has(key) || key === "Animal") {
                if (value instanceof __dk_window.ObjClosure) value.moduleGlobals = moduleVM.globals;
                exports.data['^' + key] = value;
            }
        }

        // Export global functions
        for (let [key, value] of moduleVM.globalFunctions) {
            if (value instanceof __dk_window.ObjClosure) value.moduleGlobals = moduleVM.globals;
            exports.data['^' + key] = value;
        }

        this.logger(`[VM] Successfully loaded module: "${resolvedPath}" with ${Object.keys(exports.data).length - 1} exports.`);
        return exports; 

    } catch (e) {
        this.logger(`[VM ERROR] Failed to process module "${resolvedPath}": ${e.message}`);
        throw e;
    }
}

    async invokeGlobal(name, args = []) {
        if (!this.globals.has(name) && !this.globalFunctions.has(name)) return null;
        const ObjFunction = __dk_window.ObjFunction;
        const fn = new ObjFunction(`<invoke:${name}>`);

        const nameIdx = fn.constants.push(name) - 1;
        fn.code.push(OPS.GET_GLOBAL, nameIdx);
        for (const arg of args) {
            const argIdx = fn.constants.push(arg) - 1;
            fn.code.push(OPS.CONST, argIdx);
        }
        fn.code.push(OPS.CALL, args.length);
        fn.code.push(OPS.RETURN);

        return await this.interpret(fn);
    }

    // Safely executes a DK closure from inside a Native JS Function
    async executeClosure(closure, args = []) {
        if (closure instanceof __dk_window.NativeFunction) {
            let res = closure.fn(...args);
            return res instanceof Promise ? await res : res;
        }
        if (!(closure instanceof __dk_window.ObjClosure)) return null;
        
        const targetFrameCount = this.frameCount;
        const targetSp = this.sp;
        
        this.pushValue(closure);
        for (const arg of args) {
            this.pushValue(arg);
        }
        
        this.pushFrame(closure, args.length);
        this.assertRuntimeState(`executeClosure:${closure?.function?.name || "<anon>"}:entry`);
        
        // AWAIT the async VM run loop
        const result = await this.run(targetFrameCount, targetSp);
        this.assertRuntimeState(`executeClosure:${closure?.function?.name || "<anon>"}:exit`);
        return result;
    }

    initNativeFunctions() {
        const NativeFunction = __dk_window.NativeFunction;
        const define = (name, arityOrFn, maybeFn) => {
            let arity = typeof arityOrFn === 'number' ? arityOrFn : arityOrFn.length;
            let fn = typeof arityOrFn === 'function' ? arityOrFn : maybeFn;
            const nativeFn = new __dk_window.NativeFunction(name, arity, fn);
            
            // Register BOTH the standard name and the compiler's safe '__builtin_' alias
            this.systemTools.set(name, nativeFn); 
            this.systemTools.set(`__builtin_${name}`, nativeFn); 
        };

        // --- CORE TOOLS ---
        define("print", async (v) => { 
            if (v === "CLS") this.logger("CLS"); 
            else this.logger(this.stringify(v)); 
            return null; 
        });
        define("clock", async () => Date.now());
        define("str", async (v) => this.stringify(v));
        define("num", async (v) => Number(v));
        define("host_has", async (name) => {
            const capability = String(name || "");
            if (!capability) return false;
            if (!this.host) return false;
            if (typeof this.host.hasCapability === "function") {
                return !!(await this.host.hasCapability(capability, {
                    fromPath: this.currentScriptPath
                }));
            }
            if (this.host.capabilities instanceof Map) {
                return this.host.capabilities.has(capability);
            }
            if (this.host.capabilities && typeof this.host.capabilities === "object") {
                return typeof this.host.capabilities[capability] === "function";
            }
            return false;
        });
        define("host_call", async (name, args) => {
            const capability = String(name || "");
            if (!capability) {
                throw this.makeDKError("host_call requires a non-empty capability name", {
                    type: "HostError",
                    code: "HOST_INVALID_CAPABILITY",
                    location: "host_call"
                });
            }
            if (!this.host || typeof this.host.callCapability !== "function") {
                throw this.makeDKError("Host capability bridge is unavailable in this host", {
                    type: "HostError",
                    code: "HOST_BRIDGE_UNAVAILABLE",
                    location: "host_call"
                });
            }

            let jsArgs = this.hostValueToJS(args);
            if (jsArgs === null || jsArgs === undefined) jsArgs = [];
            else if (!Array.isArray(jsArgs)) jsArgs = [jsArgs];

            try {
                const result = await this.host.callCapability(capability, jsArgs, {
                    fromPath: this.currentScriptPath
                });
                return this.hostValueFromJS(result);
            } catch (error) {
                if (error && typeof error === "object" && error.type === "arr" && error.data) {
                    throw error;
                }
                const message = error instanceof Error ? error.message : String(error ?? "Host capability failed");
                throw this.makeDKError(message, {
                    type: "HostError",
                    code: "HOST_CALL_FAILED",
                    location: `host_call:${capability}`
                });
            }
        });
        // Update type()
        define("type", async (v) => {
            // FIX: Reverted to "object" to satisfy the DK Test Suite
            if (ArrayBuffer.isView(v)) return "object"; 
            if (this.isDKArray(v) || this.isDKWrapper(v)) return "arr";
            if (this.isStringView(v) || typeof v === 'string') return "str";
            return typeof v;
        });
        
        // --- MEMORY BUFFERS ---
        define("buffer", async (size, type) => {
            if (typeof __dk_window.dkBufferCreate === 'function') {
                return __dk_window.dkBufferCreate(size, type || 'f32');
            }
            return null;
        });

        // --- STRING TOOLS ---
        define("len", async (x) => {
            if (ArrayBuffer.isView(x)) return x.length;
            if (this.isStringView(x)) return String(x.text ?? "").length;
            if (this.isDKArray(x) || this.isDKWrapper(x)) return this.getArrayLength(x);
            return String(x).length;
        });
        define("upper", async (s) => String(s).toUpperCase());
        define("lower", async (s) => String(s).toLowerCase());
        define("trim", async (s) => String(s).trim());
        // --- THE SENSORY KNIFE (Two-Stage Split) ---
        define("split", async (val, pattern, limit) => {
            if (val === null || val === undefined) return null;

            const isView = (val && val.type === 'strview');
            const base = isView ? val._base : this.globalBase;
            const isBuffer = ArrayBuffer.isView(val);
            const isDKArr = this.isDKArray(val) || this.isDKWrapper(val);
            
            let isStringResult = typeof val === 'string' || isView;
            const sourceStr = isStringResult ? (isView ? val.text : val) : null;
            let resultItems = [];
            
            let l = (limit === undefined || limit === null) ? Infinity : Number(limit);
            if (l <= 0) return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate([], 1) : [];

            // ==========================================
            // STAGE 1: THE HARVEST
            // ==========================================

            if (isStringResult) {
                if (pattern instanceof RegExp) {
                    // A. Regex Sieve & Remainder
                    let r = new RegExp(pattern, pattern.flags + (pattern.flags.includes('g') ? '' : 'g'));
                    let match;
                    let lastIdx = 0;
                    let count = 0;
                    
                    while ((match = r.exec(sourceStr)) !== null) {
                        if (count >= l - 1) break;
                        
                        resultItems.push(sourceStr.slice(lastIdx, match.index));
                        
                        // Keep Capturing Groups (The Sieve)
                        for (let i = 1; i < match.length; i++) {
                            if (match[i] !== undefined) resultItems.push(match[i]);
                        }
                        
                        lastIdx = r.lastIndex;
                        count++;
                        
                        // Prevent infinite loops on zero-width matches
                        if (match.index === r.lastIndex) r.lastIndex++; 
                    }
                    resultItems.push(sourceStr.slice(lastIdx));
                } else {
                    // B. Standard String Split & Remainder
                    let delim = String(pattern);
                    let cursor = 0;
                    let count = 0;
                    
                    if (delim === "") {
                        let chars = sourceStr.split("");
                        if (l < chars.length) {
                            resultItems = chars.slice(0, l - 1);
                            resultItems.push(chars.slice(l - 1).join(""));
                        } else {
                            resultItems = chars;
                        }
                    } else {
                        while (count < l - 1) {
                            let idx = sourceStr.indexOf(delim, cursor);
                            if (idx === -1) break;
                            resultItems.push(sourceStr.slice(cursor, idx));
                            cursor = idx + delim.length;
                            count++;
                        }
                        resultItems.push(sourceStr.slice(cursor));
                    }
                }
            } 
            else if (isBuffer) {
                // C. High-Speed Binary Seeking (Zero-Copy)
                let count = 0;
                let cursor = 0;
                let pArr = Array.isArray(pattern) ? pattern : (this.isDKWrapper(pattern) ? pattern.data.slice(this.getArrayBase(pattern)) : [Number(pattern)]);
                let pLen = pArr.length;

                for (let i = 0; i <= val.length - pLen; i++) {
                    if (count >= l - 1) break;
                    let match = true;
                    for (let j = 0; j < pLen; j++) {
                        if (val[i + j] !== pArr[j]) { match = false; break; }
                    }
                    if (match) {
                        resultItems.push(val.subarray(cursor, i));
                        cursor = i + pLen;
                        i += pLen - 1; // skip over the delimiter
                        count++;
                    }
                }
                resultItems.push(val.subarray(cursor));
            } else {
                // D. Array Split (Fallback)
                let arr = this.isDKWrapper(val) ? val.data.slice(this.getArrayBase(val)) : val;
                let delim = Number(pattern);
                let count = 0;
                let cursor = 0;
                for (let i = 0; i < arr.length; i++) {
                    if (count >= l - 1) break;
                    if (arr[i] === delim) {
                        resultItems.push(arr.slice(cursor, i));
                        cursor = i + 1;
                        count++;
                    }
                }
                resultItems.push(arr.slice(cursor));
            }

            let defaultResult = typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(Array.from(resultItems), 1) : Array.from(resultItems);

            // ==========================================
            // STAGE 2: THE RESTRUCTURING RESOLVER
            // ==========================================
            return new __dk_window.NativeFunction("restructure", 1, async (sigil) => {
                if (!sigil) return defaultResult; 
                
                const cmd = String(sigil).toLowerCase();
                
                if (['f', '_', 'flat'].includes(cmd)) {
                    if (isStringResult) return resultItems.join('');
                    if (isBuffer) {
                        let totalLen = resultItems.reduce((acc, b) => acc + b.length, 0);
                        let merged = new Uint8Array(totalLen);
                        let offset = 0;
                        for (let b of resultItems) { merged.set(b, offset); offset += b.length; }
                        if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(merged);
                        return merged;
                    }
                    return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(resultItems.flat(), 1) : resultItems.flat();
                }
                
                if (['v', '<', 'vector'].includes(cmd)) {
                    let vecArray = resultItems.map(item => {
                        const vec = new Float32Array(Array.isArray(item) ? item : (item.length !== undefined ? item : [item]));
                        if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(vec);
                        return vec;
                    });
                    return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(vecArray, 1) : vecArray;
                }
                
                if (['b', '#', 'buffer'].includes(cmd)) {
                    let bufArray = resultItems.map(item => {
                        const buf = new Uint8Array(Array.isArray(item) ? item : (item.length !== undefined ? item : [item]));
                        if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(buf);
                        return buf;
                    });
                    return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(bufArray, 1) : bufArray;
                }

                return defaultResult;
            });
        });
        define("join", async (a, d) => {
            if (this.isDKArray(a)) {
                return a.join(String(d));
            }
            if (this.isDKWrapper(a)) {
                const base = this.getArrayBase(a);
                return a.data.slice(base).join(String(d));
            }
            return String(a);
        });
        define("replace", async (s, f, r) => String(s).replace(String(f), String(r)));
        
        define("sub", async (t, p, r) => {
             let re = p;
             if (p instanceof RegExp) { if (!p.global) re = new RegExp(p.source, p.flags + "g"); } else { re = new RegExp(p, "g"); }
             return String(t).replace(re, r);
        });
        // --- STRING FORMATTING & QUERYING ---
        define("startsWith", async (str, search) => {
            if (str === null || str === undefined) return false;
            return String(str).startsWith(String(search));
        });
        
        define("endsWith", async (str, search) => {
            if (str === null || str === undefined) return false;
            return String(str).endsWith(String(search));
        });
        
        define("repeat", async (str, count) => {
            if (str === null || str === undefined) return "";
            return String(str).repeat(Math.max(0, Number(count) || 0));
        });
        
        define("padStart", async (str, len, pad) => {
            if (str === null || str === undefined) return "";
            return String(str).padStart(Number(len) || 0, pad !== undefined ? String(pad) : " ");
        });
        
        define("padEnd", async (str, len, pad) => {
            if (str === null || str === undefined) return "";
            return String(str).padEnd(Number(len) || 0, pad !== undefined ? String(pad) : " ");
        });
        

        define("match", async (t, p) => { 
            if (t === null || t === undefined) return null;
            const re = (p instanceof RegExp) ? p : new RegExp(p);
            const m = String(t).match(re); 
            if (!m) return null;

            const res = { type: 'arr', data: [null], _base: 1 };
            res.data["^full"] = m[0];         // Target for res.full
            res.data["^len"] = m[0].length;   // Target for res.len
            res.data["^index"] = m.index + this.globalBase;
            
            m.forEach((capture, i) => { res.data[i + 1] = capture; });
            return res;
        });
        // Add these to initNativeFunctions() in your provided vm.js

        // match_at(string, regex, index) -> Metadata Map
        define("match_at", async (text, regex, offset) => {
            if (text === null || text === undefined) return null;
            const str = String(text);
            const start = Number(offset || 0);
            
            // Ensure the regex is anchored to the start of the substring
            const source = (regex instanceof RegExp) ? regex.source : String(regex);
            const flags = (regex instanceof RegExp) ? regex.flags : "";
            const anchoredRegex = new RegExp(source.startsWith('^') ? source : '^' + source, flags);

            // Perform match from the specific offset
            const m = str.substring(start).match(anchoredRegex);
            if (!m) return null;

            const res = { type: 'arr', data: [null], _base: 1 };
            res.data[0] = m[0];
            res.data["^full"] = m[0];
            res.data["^len"] = m[0].length;
            res.data["^index"] = start;
            
            m.forEach((capture, i) => { res.data[i + 1] = capture; });
            return res;
        });

        // char(code) -> Converts ASCII/Unicode to String
        define("char", async (code) => String.fromCharCode(Number(code)));

        // NEW: ord() for character-code analysis
        define("ord", async (s, index) => {
            if (s === null || s === undefined) return null;
            const str = (s && s.type === 'strview') ? s.text : String(s);
            const base = (s && s.type === 'strview') ? s._base : this.globalBase;
            const i = (index === undefined) ? 0 : (Number(index) - base);
            if (i < 0 || i >= str.length) return null;
            return str.charCodeAt(i);
        });

        define("has", async (c, p) => {
            if (typeof c === 'string') {
                const re = (p instanceof RegExp) ? p : new RegExp(String(p));
                return re.test(c);
            }
            if (this.isDKArray(c)) {
                if (typeof p === "number") return this.getArrayValue(c, p) !== undefined;
                return this.getMapValue(c, p) !== undefined;
            }
            if (this.isDKWrapper(c)) { 
                // Maps use prefixed keys, wrappers with numeric queries use DK index semantics.
                if (typeof p === "number") return this.getArrayValue(c, p) !== undefined;
                return this.getMapValue(c, p) !== undefined;
            }
            let re = (p instanceof RegExp) ? p : new RegExp(p);
            return re.test(String(c));
        });
        

        // --- MATH ---
        define("max", Math.max); define("min", Math.min); define("abs", Math.abs);
        define("floor", Math.floor); define("ceil", Math.ceil); define("round", Math.round);
        define("sqrt", Math.sqrt); define("pow", Math.pow);

        // --- ARRAY TOOLS ---
        define("push", async (arr, v) => { 
            if (this.isDKArray(arr)) {
                arr.push(v);
                this.getHybridKeySlots(arr);
                return this.getArrayLength(arr);
            }
            if(this.isDKWrapper(arr)) { 
                arr.data.push(v); 
                return this.getArrayLength(arr); 
            }
            return 0;
        });
        define("pop", async (arr) => { 
            if (this.isDKArray(arr)) {
                const slots = this.getHybridKeySlots(arr);
                slots.pop();
                return arr.pop();
            }
            if(this.isDKWrapper(arr)) { return arr.data.pop(); } 
            return null; 
        });
        define("shift", async (arr) => {
            if (this.isDKArray(arr) && arr.length > 0) {
                const slots = this.getHybridKeySlots(arr);
                slots.shift();
                return arr.shift();
            }
            if (this.isDKWrapper(arr) && arr.data.length > this.getArrayBase(arr)) {
                return arr.data.splice(this.getArrayBase(arr), 1)[0];
            }
            return null;
        });
        define("unshift", async (arr, val) => {
            if (this.isDKArray(arr)) {
                arr.unshift(val);
                const slots = this.getHybridKeySlots(arr);
                slots.unshift(null);
                return this.getArrayLength(arr);
            }
            if (this.isDKWrapper(arr)) {
                arr.data.splice(this.getArrayBase(arr), 0, val);
                return this.getArrayLength(arr);
            }
            return 0;
        });
        define("contains", async (arr, val) => {
            if (this.isDKArray(arr)) return arr.includes(val);
            if (!this.isDKWrapper(arr)) return false;
            for (let i = this.getArrayBase(arr); i < arr.data.length; i++) {
                if (arr.data[i] === val) return true;
            }
            return false;
        });
        // --- ADVANCED ARRAYS & MEMORY ---
        define("indexOf", async (obj, search, start) => {
            if (obj === null || obj === undefined) return -1;
            // 1. String / String View
            if (typeof obj === 'string' || this.isStringView(obj)) {
                const str = this.isStringView(obj) ? String(obj.text ?? "") : String(obj);
                const base = this.isStringView(obj) ? Number(obj._base ?? this.globalBase) : this.globalBase;
                const s = start === undefined ? 0 : Number(start) - base;
                const idx = str.indexOf(String(search), s);
                return idx !== -1 ? idx + base : -1;
            }
            // 2. DK Native Array
            if (this.isDKArray(obj)) {
                const base = this.getArrayBase(obj);
                const s = start === undefined ? 0 : Number(start) - base;
                const idx = obj.indexOf(search, s);
                return idx !== -1 ? idx + base : -1;
            }
            // 3. DK Wrapper Array
            if (this.isDKWrapper(obj)) {
                const base = this.getArrayBase(obj);
                const s = start === undefined ? base : Number(start) - base + 1;
                const idx = obj.data.indexOf(search, s);
                return idx !== -1 ? idx + base - 1 : -1;
            }
            return -1;
        });

        define("splice", async (arr, start, deleteCount, ...items) => {
            let deleted = [];
            if (this.isDKArray(arr)) {
                const base = this.getArrayBase(arr);
                const s = Number(start) - base;
                const d = deleteCount === undefined ? arr.length - s : Number(deleteCount);
                const slots = this.getHybridKeySlots(arr);
                const deletedSlots = slots.splice(s, d, ...new Array(items.length).fill(null));
                deleted = arr.splice(s, d, ...items);
                const out = typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(deleted, 1) : deleted;
                if (this.isDKArray(out)) {
                    const outSlots = this.getHybridKeySlots(out);
                    outSlots.length = 0;
                    outSlots.push(...deletedSlots);
                }
                return out;
            }
            if (this.isDKWrapper(arr)) {
                const base = this.getArrayBase(arr);
                const s = Number(start) - base + 1;
                const d = deleteCount === undefined ? arr.data.length - s : Number(deleteCount);
                deleted = arr.data.splice(s, d, ...items);
                return { type: 'arr', data: [null, ...deleted], _base: 1 };
            }
            return null;
        });

        // Update fill()
        define("fill", async (arr, val, start, end) => {
            if (this.isDKArray(arr) || ArrayBuffer.isView(arr)) {
                const base = this.getArrayBase(arr);
                const s = start === undefined ? 0 : Number(start) - base;
                const e = end === undefined ? arr.length : Number(end) - base;
                arr.fill(val, s, e);
                return arr;
            }
            if (this.isDKWrapper(arr)) {
                const base = this.getArrayBase(arr);
                const s = start === undefined ? base : Number(start) - base + 1;
                const e = end === undefined ? arr.data.length : Number(end) - base + 1;
                arr.data.fill(val, s, e);
                return arr;
            }
            return arr;
        });

        // --- MAP TOOLS (Prefix Aware) ---
        define("keys", async (obj) => {
            if (!obj || typeof obj !== 'object') return { type: 'arr', data: [null], _base: 1 };
            const keys = (this.isDKWrapper(obj) || this.isDKArray(obj))
                ? this.getMapKeys(obj)
                : Object.keys(obj);
            if (typeof __dk_window.dkArrayCreate === "function") return __dk_window.dkArrayCreate(keys, 1);
            return keys;
        });

        define("values", async (obj) => {
            if (!obj || typeof obj !== 'object') return { type: 'arr', data: [null], _base: 1 };
            const vals = (this.isDKWrapper(obj) || this.isDKArray(obj))
                ? this.getMapValues(obj)
                : Object.values(obj);
            if (typeof __dk_window.dkArrayCreate === "function") return __dk_window.dkArrayCreate(vals, 1);
            return vals;
        });

        define("remove", async (obj, key) => {
            if (!this.isDKWrapper(obj) && !this.isDKArray(obj)) return null;
            const internalKey = this.normalizeMapKey(key);
            if (this.isDKWrapper(obj) && obj.data[internalKey] !== undefined) {
                const val = obj.data[internalKey];
                delete obj.data[internalKey];
                return val;
            }
            if (this.isDKArray(obj)) {
                return this.removeHybridEntry(obj, key);
            }
            return null;
        });

        define("merge", async (dest, source) => {
            if (!dest || !source) return dest;
            if ((!this.isDKWrapper(dest) && !this.isDKArray(dest)) ||
                (!this.isDKWrapper(source) && !this.isDKArray(source))) return dest;
            if (this.isDKArray(dest) || this.isDKArray(source)) {
                this.mergeCollectionInto(dest, source);
                return dest;
            }
            const keys = this.getMapKeys(source);
            for (const k of keys) {
                this.setMapValue(dest, k, this.getMapValue(source, k));
            }
            return dest;
        });

        // --- FUNCTIONAL ITERATORS ---
        define("forEach", async (arr, fn) => {
            if (!this.isDKArray(arr) && !this.isDKWrapper(arr)) return arr;
            if (!(fn instanceof __dk_window.ObjClosure || fn instanceof __dk_window.NativeFunction)) return arr;

            const isWrap = this.isDKWrapper(arr);
            const base = this.getArrayBase(arr);
            const items = isWrap ? arr.data.slice(base) : arr;

            for (let i = 0; i < items.length; i++) {
                await this.executeClosure(fn, [items[i], i + base, arr]);
            }
            return arr;
        });

        define("map", async (arr, fn) => {
            if (!this.isDKArray(arr) && !this.isDKWrapper(arr)) return arr;
            if (!(fn instanceof __dk_window.ObjClosure || fn instanceof __dk_window.NativeFunction)) return arr;

            const isWrap = this.isDKWrapper(arr);
            const base = this.getArrayBase(arr);
            const items = isWrap ? arr.data.slice(base) : arr;
            
            const result = [];
            for (let i = 0; i < items.length; i++) {
                // Wait for the DK bytecode to finish math before pushing!
                const res = await this.executeClosure(fn, [items[i], i + base, arr]);
                result.push(res);
            }
            
            return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(result, 1) : result;
        });

        define("filter", async (arr, fn) => {
            if (!this.isDKArray(arr) && !this.isDKWrapper(arr)) return arr;
            if (!(fn instanceof __dk_window.ObjClosure || fn instanceof __dk_window.NativeFunction)) return arr;

            const isWrap = this.isDKWrapper(arr);
            const base = this.getArrayBase(arr);
            const items = isWrap ? arr.data.slice(base) : arr;
            
            const result = [];
            for (let i = 0; i < items.length; i++) {
                const keep = await this.executeClosure(fn, [items[i], i + base, arr]);
                if (keep) result.push(items[i]);
            }
            
            return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(result, 1) : result;
        });

        define("some", async (arr, fn) => {
            if (!this.isDKArray(arr) && !this.isDKWrapper(arr)) return false;
            if (!(fn instanceof __dk_window.ObjClosure || fn instanceof __dk_window.NativeFunction)) return false;

            const isWrap = this.isDKWrapper(arr);
            const base = this.getArrayBase(arr);
            const items = isWrap ? arr.data.slice(base) : arr;

            for (let i = 0; i < items.length; i++) {
                if (await this.executeClosure(fn, [items[i], i + base, arr])) return true;
            }
            return false;
        });

        define("every", async (arr, fn) => {
            if (!this.isDKArray(arr) && !this.isDKWrapper(arr)) return false;
            if (!(fn instanceof __dk_window.ObjClosure || fn instanceof __dk_window.NativeFunction)) return false;

            const isWrap = this.isDKWrapper(arr);
            const base = this.getArrayBase(arr);
            const items = isWrap ? arr.data.slice(base) : arr;

            if (items.length === 0) return true;
            for (let i = 0; i < items.length; i++) {
                if (!(await this.executeClosure(fn, [items[i], i + base, arr]))) return false;
            }
            return true;
        });

        define("reduce", async (arr, fn, initValue) => {
            if (!this.isDKArray(arr) && !this.isDKWrapper(arr)) return arr;
            if (!(fn instanceof __dk_window.ObjClosure || fn instanceof __dk_window.NativeFunction)) return arr;

            const isWrap = this.isDKWrapper(arr);
            const base = this.getArrayBase(arr);
            const items = isWrap ? arr.data.slice(base) : arr;

            if (items.length === 0 && initValue === undefined) return null;

            let acc = initValue !== undefined ? initValue : items[0];
            let startIndex = initValue !== undefined ? 0 : 1;

            for (let i = startIndex; i < items.length; i++) {
                acc = await this.executeClosure(fn, [acc, items[i], i + base, arr]);
            }
            return acc;
        });

        // --- JSON TOOLS (Using global toDK/toJS from shared.js) ---
        define("json_parse", async (str) => {
            try { return toDK(JSON.parse(String(str))); } 
            catch (e) { return null; }
        });

        define("json_str", async (obj) => {
            try { return JSON.stringify(toJS(obj), null, 2); } 
            catch (e) { return null; }
        });
        // ... inside initNativeFunctions() ...

        define("sub", async (t, p, r) => {
             let re = p;
             if (p instanceof RegExp) { if (!p.global) re = new RegExp(p.source, p.flags + "g"); } else { re = new RegExp(p, "g"); }
             return String(t).replace(re, r);
        });

        // --- THE SENSORY HAND (Two-Stage Slice) ---
        define("slice", async (val, selector, end, step) => {
            if (val === null || val === undefined) return null;

            const isView = (val && val.type === 'strview');
            const base = isView ? val._base : this.globalBase;
            const isBuffer = ArrayBuffer.isView(val);
            const isDKArr = this.isDKArray(val) || this.isDKWrapper(val);
            
            let resultItems = [];
            let isStringResult = typeof val === 'string' || isView;
            
            const getLen = () => isStringResult ? (isView ? val.text.length : val.length) : (isBuffer ? val.length : this.getArrayLength(val));
            
           // FIX: Perfect 1-Based to 0-Based conversion for JS Slice
            const resolveIdx = (idx, isEnd = false) => {
                if (idx === undefined || idx === null) return isEnd ? getLen() : 0;
                let n = Number(idx);
                if (n < 0) n = getLen() + n + (base === 1 ? 1 : 0); 
                // Exclusive JS slice needs +1 to include the DK end index
                return isEnd ? (n - base) + 1 : (n - base);
            };

            // ==========================================
            // STAGE 1: THE HARVEST
            // ==========================================

            // A. MULTI-INDEX PICK: slice([1, 3, 5])
            if (this.isDKArray(selector) || this.isDKWrapper(selector) || Array.isArray(selector)) {
                const indices = this.isDKWrapper(selector) ? selector.data.slice(this.getArrayBase(selector)) : selector;
                for (let i = 0; i < indices.length; i++) {
                    // For specific picks, we don't treat them as 'ends', just exact points.
                    const rIdx = resolveIdx(indices[i], false); 
                    if (isStringResult) {
                        const str = isView ? val.text : val;
                        resultItems.push(str[rIdx]);
                    } else if (isBuffer || isDKArr) {
                        const v = isBuffer ? val[rIdx] : this.getArrayValueAtBase(val, rIdx + base, base);
                        resultItems.push(v === undefined ? null : v);
                    }
                }
            }
            // B. RANGE & STEP STRIDE: slice(1, 10, 2)
            else {
                const s = resolveIdx(selector, false);
                const e = resolveIdx(end, true);
                const stp = (step === undefined || step === null) ? 1 : Number(step);

                if (isStringResult) {
                    const str = isView ? val.text : val;
                    if (stp === 1) {
                        resultItems = [str.slice(s, e)]; // ZERO-COPY
                    } else {
                        for (let i = s; i < e; i += stp) resultItems.push(str[i]);
                    }
                } else if (isBuffer || isDKArr) {
                    if (stp === 1 && isBuffer) {
                        resultItems = [val.subarray(s, e)]; // ZERO-COPY
                    } else {
                        const sourceItems = isBuffer ? val : (this.isDKWrapper(val) ? val.data.slice(this.getArrayBase(val)) : val);
                        if (stp === 1) {
                            resultItems = Array.from(sourceItems.slice(s, e));
                        } else {
                            for (let i = s; i < e; i += stp) resultItems.push(sourceItems[i]);
                        }
                    }
                }
            }

            // Standardize Default Output
            let defaultResult;
            if (isStringResult && resultItems.length === 1 && typeof resultItems[0] === 'string') {
                defaultResult = isView ? { type: 'strview', text: resultItems[0], _base: base } : resultItems[0];
            } else if (isBuffer && resultItems.length === 1 && ArrayBuffer.isView(resultItems[0])) {
                defaultResult = resultItems[0];
                this.setArrayBase(defaultResult, base);
            } else {
                defaultResult = typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(Array.from(resultItems), 1) : Array.from(resultItems);
            }

            // ==========================================
            // STAGE 2: THE RESTRUCTURING RESOLVER 
            // (Keep this exactly as you have it)
            // ==========================================
            return new __dk_window.NativeFunction("restructure", 1, async (sigil) => {
                if (!sigil) return defaultResult; 
                const cmd = String(sigil).toLowerCase();
                
                // (f) Flat
                if (['f', '_', 'flat'].includes(cmd)) {
                    if (isStringResult && Array.isArray(defaultResult)) return defaultResult.join('');
                    if (this.isDKArray(defaultResult)) return defaultResult.join(''); 
                    return defaultResult;
                }
                
                // (v) Vector
                if (['v', '<', 'vector'].includes(cmd)) {
                    const arr = this.isDKWrapper(defaultResult) ? defaultResult.data.slice(1) : defaultResult;
                    const vec = new Float32Array(Array.isArray(arr) ? arr : [arr]);
                    if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(vec);
                    return vec;
                }
                
                // (b) Buffer
                if (['b', '#', 'buffer'].includes(cmd)) {
                    const arr = this.isDKWrapper(defaultResult) ? defaultResult.data.slice(1) : defaultResult;
                    const buf = new Uint8Array(Array.isArray(arr) ? arr : [arr]);
                    if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(buf);
                    return buf;
                }

                return defaultResult;
            });
        });
        
        // --- THE SENSORY ARCHITECT (Unified Discovery & Geometric) ---
        define("chunk", async (val, a, b, c, d) => {
            if (val === null || val === undefined) return null;

            const isView = (val && val.type === 'strview');
            const base = isView ? val._base : this.globalBase;
            const isBuffer = ArrayBuffer.isView(val);
            let isStringResult = typeof val === 'string' || isView;
            
            const getLen = () => isStringResult ? (isView ? val.text.length : val.length) : (isBuffer ? val.length : this.getArrayLength(val));
            const source = isView ? val.text : (isBuffer ? val : (this.isDKWrapper(val) ? val.data.slice(this.getArrayBase(val)) : val));
            const len = getLen();
            
            let resultItems = [];

            // 1. Determine Mode & Extract Params
            const asSeq = (x) => {
                if (this.isDKWrapper(x)) return Array.from(x.data.slice(this.getArrayBase(x)));
                if (this.isDKArray(x) || Array.isArray(x)) return Array.from(x);
                return null;
            };
            const grab = (start, end) => {
                if (isStringResult) return source.slice(start, end);
                if (isBuffer) return source.subarray(start, end);
                return Array.from(source.slice(start, end));
            };

            let isDiscovery = false;
            let seekVal, takeVal, skipVal, limitVal;
            let widthPattern = null;
            let w, s, remPolicy;

            const tuple = asSeq(a);
            if (this.isDKWrapper(a) && this.getMapKeys(a).length > 0) {
                isDiscovery = true;
                seekVal = this.getMapValue(a, "seek");
                takeVal = this.getMapValue(a, "take");
                skipVal = Number(this.getMapValue(a, "skip") || 0);
                limitVal = this.getMapValue(a, "limit");
            } else if (tuple) {
                // Width-pattern mode is only for true numeric tuples like [2,3,1].
                // Do not coerce strings/null here, or discovery tuples like [" ", null]
                // get misclassified and yield empty results.
                const numericOnly = tuple.length > 0 && tuple.every(v => (typeof v === 'number') && Number.isFinite(v));
                if (numericOnly) {
                    widthPattern = tuple.map(v => Number(v));
                } else {
                    isDiscovery = true;
                    seekVal = tuple[0];
                    takeVal = tuple.length > 1 ? tuple[1] : undefined;
                    skipVal = Number(tuple.length > 2 ? tuple[2] : 0);
                    limitVal = tuple.length > 3 ? tuple[3] : Infinity;
                }
            } else if (typeof a === 'string') {
                isDiscovery = true;
                seekVal = a;
                takeVal = b;
                skipVal = Number(c || 0);
                limitVal = d;
            } else {
                w = Number(a);
                s = (b === undefined || b === null) ? w : Number(b);
                remPolicy = c ? String(c).toLowerCase() : "keep";
            }

            if (takeVal === null) takeVal = undefined;
            const limNum = Number(limitVal);
            limitVal = Number.isFinite(limNum) && limNum > 0 ? limNum : Infinity;
            skipVal = Number.isFinite(skipVal) && skipVal > 0 ? Math.floor(skipVal) : 0;

            if (isDiscovery) {
                const findNext = (from) => {
                    if (typeof source === 'string') {
                        const seekStr = String(seekVal);
                        return source.indexOf(seekStr, from);
                    }
                    const rawNeedle = asSeq(seekVal);
                    const needle = Array.isArray(rawNeedle) ? rawNeedle : [Number(seekVal)];
                    const needleLen = needle.length;
                    if (needleLen <= 0) return -1;
                    for (let i = from; i <= len - needleLen; i++) {
                        let match = true;
                        for (let j = 0; j < needleLen; j++) {
                            if (source[i + j] !== needle[j]) { match = false; break; }
                        }
                        if (match) return i;
                    }
                    return -1;
                };

                const needleLen = (typeof source === 'string')
                    ? String(seekVal).length
                    : (() => {
                        const rawNeedle = asSeq(seekVal);
                        const needle = Array.isArray(rawNeedle) ? rawNeedle : [Number(seekVal)];
                        return needle.length;
                    })();

                if (needleLen > 0) {
                    let cursor = 0;
                    let count = 0;
                    while (cursor < len && count < limitVal) {
                        const foundIdx = findNext(cursor);
                        if (foundIdx === -1) break;

                        const start = foundIdx + needleLen;
                        let end;
                        if (takeVal !== undefined) {
                            end = Math.min(start + Number(takeVal), len);
                        } else {
                            const nextMatch = findNext(start);
                            end = (nextMatch !== -1) ? nextMatch : len;
                        }

                        resultItems.push(grab(start, end));
                        count++;
                        cursor = end;

                        // Skip N subsequent matches (match-level skipping, not char-level).
                        for (let skipped = 0; skipped < skipVal; skipped++) {
                            const skipIdx = findNext(cursor);
                            if (skipIdx === -1) { cursor = len; break; }
                            cursor = skipIdx + needleLen;
                        }
                    }
                }
            } else if (widthPattern) {
                let cursor = 0;
                for (const width of widthPattern) {
                    const wi = Number(width);
                    if (!Number.isFinite(wi) || wi <= 0 || cursor >= len) break;
                    const end = Math.min(cursor + wi, len);
                    resultItems.push(grab(cursor, end));
                    cursor += wi;
                }
            } else {
                if (w <= 0 || s <= 0) return null;
                let cursor = 0;
                while (cursor < len) {
                    let end = cursor + w;
                    if (end > len) {
                        if (remPolicy === "trim") break;
                        if (remPolicy === "pad") {
                            let frag = grab(cursor, len);
                            let padSize = w - (len - cursor);
                            if (isStringResult) resultItems.push(frag + " ".repeat(padSize));
                            else if (isBuffer) {
                                let bbuf = new Uint8Array(w);
                                bbuf.set(frag);
                                resultItems.push(bbuf);
                            } else {
                                resultItems.push([...frag, ...new Array(padSize).fill(null)]);
                            }
                        } else {
                            resultItems.push(grab(cursor, len));
                        }
                        break;
                    }
                    resultItems.push(grab(cursor, end));
                    cursor += s;
                }
            }

            return new __dk_window.NativeFunction("restructure", 1, async (...sigils) => {
                const wrapInDK = (arr) => (typeof __dk_window.dkArrayCreate === "function") ? __dk_window.dkArrayCreate(arr, 1) : arr;
                if (!sigils || sigils.length === 0) return wrapInDK(resultItems);

                const cmdSource = [];
                const collectCmd = (v) => {
                    if (v === null || v === undefined) return;
                    if (this.isDKWrapper(v) || this.isDKArray(v) || Array.isArray(v)) {
                        const seq = this.isDKWrapper(v)
                            ? v.data.slice(this.getArrayBase(v))
                            : Array.from(v);
                        for (const item of seq) collectCmd(item);
                        return;
                    }
                    const s = String(v).trim();
                    if (s.length > 0) cmdSource.push(s);
                };
                for (const s of sigils) collectCmd(s);
                if (cmdSource.length === 0) return wrapInDK(resultItems);

                const cmds = cmdSource.join(' ').trim().split(/[\s,]+/);
                let current = resultItems;

                for (const cmd of cmds) {
                    if (cmd === 'f' || cmd === 'flat') {
                        if (isStringResult) current = [current.join('')];
                        else if (isBuffer) {
                            let total = current.reduce((a, b) => a + b.length, 0);
                            let m = new Uint8Array(total);
                            let off = 0;
                            for (let b of current) { m.set(b, off); off += b.length; }
                            current = [m];
                        } else current = [current.flat()];
                    }
                    if (cmd === 'u' || cmd === 'upper') {
                        current = current.map(item => typeof item === 'string' ? item.toUpperCase() : item);
                    }
                    if (cmd === 'l' || cmd === 'lower') {
                        current = current.map(item => typeof item === 'string' ? item.toLowerCase() : item);
                    }
                    if (cmd === 't' || cmd === 'trim') {
                        // Enhanced Trim: Strips whitespace AND leading/trailing punctuation for deep data cleaning
                        current = current.map(item => typeof item === 'string' ? item.trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '') : item);
                    }
                    if (cmd === 'v' || cmd === 'vector') {
                        current = current.map(item => {
                            const vec = new Float32Array(Array.isArray(item) ? item : [item]);
                            if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(vec);
                            return vec;
                        });
                    }
                    if (cmd === 'b' || cmd === 'buffer') {
                        current = current.map(item => {
                            const buf = new Uint8Array(Array.isArray(item) ? item : [item]);
                            if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(buf);
                            return buf;
                        });
                    }
                    if (cmd === 'count') {
                        const map = { type: 'arr', data: [null], _base: 1 };
                        for (let item of current) {
                            let token = String(item ?? "");
                            // Canonical tokenization for frequency maps:
                            // trim whitespace, remove edge punctuation, lowercase.
                            token = token
                                .trim()
                                .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')
                                .toLowerCase();
                            if (token === "") continue;
                            let key = "^" + token;
                            map.data[key] = (map.data[key] || 0) + 1;
                        }
                        return map;
                    }
                    if (cmd === 'e' || cmd === 'exists') {
                        return current.length > 0;
                    }
                }
                return wrapInDK(current);
            });
        });

        // --- THE SENSORY KNIFE (Two-Stage Split) ---
        define("split", async (val, pattern, limit) => {
            if (val === null || val === undefined) return null;

            const isView = (val && val.type === 'strview');
            const base = isView ? val._base : this.globalBase;
            const isBuffer = ArrayBuffer.isView(val);
            const isDKArr = this.isDKArray(val) || this.isDKWrapper(val);
            
            let isStringResult = typeof val === 'string' || isView;
            const sourceStr = isStringResult ? (isView ? val.text : val) : null;
            let resultItems = [];
            
            let l = (limit === undefined || limit === null) ? Infinity : Number(limit);
            if (l <= 0) return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate([], 1) : [];

            if (isStringResult) {
                if (pattern instanceof RegExp) {
                    let r = new RegExp(pattern, pattern.flags + (pattern.flags.includes('g') ? '' : 'g'));
                    let match;
                    let lastIdx = 0;
                    let count = 0;
                    
                    while ((match = r.exec(sourceStr)) !== null) {
                        if (count >= l - 1) break;
                        resultItems.push(sourceStr.slice(lastIdx, match.index));
                        for (let i = 1; i < match.length; i++) {
                            if (match[i] !== undefined) resultItems.push(match[i]);
                        }
                        lastIdx = r.lastIndex;
                        count++;
                        if (match.index === r.lastIndex) r.lastIndex++; 
                    }
                    resultItems.push(sourceStr.slice(lastIdx));
                } else {
                    let delim = String(pattern);
                    let cursor = 0;
                    let count = 0;
                    if (delim === "") {
                        let chars = sourceStr.split("");
                        if (l < chars.length) {
                            resultItems = chars.slice(0, l - 1);
                            resultItems.push(chars.slice(l - 1).join(""));
                        } else {
                            resultItems = chars;
                        }
                    } else {
                        while (count < l - 1) {
                            let idx = sourceStr.indexOf(delim, cursor);
                            if (idx === -1) break;
                            resultItems.push(sourceStr.slice(cursor, idx));
                            cursor = idx + delim.length;
                            count++;
                        }
                        resultItems.push(sourceStr.slice(cursor));
                    }
                }
            } else if (isBuffer) {
                let count = 0;
                let cursor = 0;
                let pArr = Array.isArray(pattern) ? pattern : (this.isDKWrapper(pattern) ? pattern.data.slice(this.getArrayBase(pattern)) : [Number(pattern)]);
                let pLen = pArr.length;

                for (let i = 0; i <= val.length - pLen; i++) {
                    if (count >= l - 1) break;
                    let match = true;
                    for (let j = 0; j < pLen; j++) {
                        if (val[i + j] !== pArr[j]) { match = false; break; }
                    }
                    if (match) {
                        resultItems.push(val.subarray(cursor, i));
                        cursor = i + pLen;
                        i += pLen - 1; 
                        count++;
                    }
                }
                resultItems.push(val.subarray(cursor));
            } else {
                let arr = this.isDKWrapper(val) ? val.data.slice(this.getArrayBase(val)) : val;
                let delim = Number(pattern);
                let count = 0;
                let cursor = 0;
                for (let i = 0; i < arr.length; i++) {
                    if (count >= l - 1) break;
                    if (arr[i] === delim) {
                        resultItems.push(arr.slice(cursor, i));
                        cursor = i + 1;
                        count++;
                    }
                }
                resultItems.push(arr.slice(cursor));
            }

            let defaultResult = typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(Array.from(resultItems), 1) : Array.from(resultItems);

            return new __dk_window.NativeFunction("restructure", 1, async (sigil) => {
                if (!sigil) return defaultResult; 
                const cmd = String(sigil).toLowerCase();
                
                if (['f', '_', 'flat'].includes(cmd)) {
                    if (isStringResult) return resultItems.join('');
                    if (isBuffer) {
                        let merged = new Uint8Array(resultItems.reduce((acc, b) => acc + b.length, 0));
                        let offset = 0;
                        for (let b of resultItems) { merged.set(b, offset); offset += b.length; }
                        if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(merged);
                        return merged;
                    }
                    return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(resultItems.flat(), 1) : resultItems.flat();
                }
                if (['v', '<', 'vector'].includes(cmd)) {
                    let vecArray = resultItems.map(item => {
                        const vec = new Float32Array(Array.isArray(item) ? item : (item.length !== undefined ? item : [item]));
                        if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(vec);
                        return vec;
                    });
                    return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(vecArray, 1) : vecArray;
                }
                if (['b', '#', 'buffer'].includes(cmd)) {
                    let bufArray = resultItems.map(item => {
                        const buf = new Uint8Array(Array.isArray(item) ? item : (item.length !== undefined ? item : [item]));
                        if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(buf);
                        return buf;
                    });
                    return typeof __dk_window.dkArrayCreate === "function" ? __dk_window.dkArrayCreate(bufArray, 1) : bufArray;
                }
                return defaultResult;
            });
        });
        
        // --- DATA MANIPULATION ---

        // CLONE: Creates a deep copy of an array or map
        // Usage: b = clone(a)
        define("clone", async (obj) => {
            if (!obj) return null;
            try {
                // toJS -> JSON stringify -> JSON parse -> toDK
                // This strips internal markers and rebuilds fresh wrappers
                return toDK(JSON.parse(JSON.stringify(toJS(obj))));
            } catch (e) { return null; }
        });

        // UNIQUE: Removes duplicates from an array
        // Usage: u = unique([1, 1, 2, 2]) -> [1, 2]
        define("unique", async (arr) => {
            if (this.isDKArray(arr)) {
                const set = new Set(arr);
                const out = Array.from(set);
                if (typeof __dk_window.dkArrayCreate === "function") return __dk_window.dkArrayCreate(out, this.getArrayBase(arr));
                return out;
            }
            if (!this.isDKWrapper(arr)) return arr;
            // Extract raw data segment
            const raw = arr.data.slice(this.getArrayBase(arr));
            // Use JS Set to dedup
            const set = new Set(raw);
            // Rebuild
            if (typeof __dk_window.dkArrayCreate === "function") return __dk_window.dkArrayCreate(Array.from(set), 1);
            return Array.from(set);
        });

        // SHUFFLE: Randomizes an array in-place
        // Usage: shuffle(deck)
        define("shuffle", async (arr) => {
            if (this.isDKArray(arr)) {
                const slots = this.getHybridKeySlots(arr);
                for (let i = arr.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [arr[i], arr[j]] = [arr[j], arr[i]];
                    [slots[i], slots[j]] = [slots[j], slots[i]];
                }
                return arr;
            }
            if (!this.isDKWrapper(arr)) return arr;
            const base = this.getArrayBase(arr);
            // Fisher-Yates Shuffle on the active segment
            for (let i = arr.data.length - 1; i > base; i--) {
                const j = Math.floor(Math.random() * (i - base + 1)) + base;
                [arr.data[i], arr.data[j]] = [arr.data[j], arr.data[i]];
            }
            return arr;
        });

        // REVERSE: Reverses an array in-place
        // Usage: reverse(list)
        define("reverse", async (arr) => {
            if (this.isDKArray(arr)) {
                arr.reverse();
                this.getHybridKeySlots(arr).reverse();
                return arr;
            }
            if (!this.isDKWrapper(arr)) return arr;
            const base = this.getArrayBase(arr);
            // Extract, reverse, splice back
            const portion = arr.data.slice(base).reverse();
            arr.data.splice(base, portion.length, ...portion);
            return arr;
        });

        // --- MATH UTILS ---

        // CLAMP: Constrains value between min and max
        // Usage: hp = clamp(hp, 0, 100)
        define("clamp", async (val, min, max) => Math.min(Math.max(Number(val), Number(min)), Number(max)));
        
        // LERP: Linear Interpolation
        // Usage: x = lerp(start, end, 0.5)
        define("lerp", async (start, end, t) => {
            const s = Number(start);
            return s + (Number(end) - s) * Number(t);
        });

        // SIGN: Returns 1, -1, or 0
        define("sign", async (n) => Math.sign(Number(n)));

        // --- WEB ENCODING ---
        
        // Base64 Encode
        define("b64_enc", async (s) => {
            try { return btoa(String(s)); } catch(e) { return null; }
        });
        
        // Base64 Decode
        define("b64_dec", async (s) => {
            try { return atob(String(s)); } catch(e) { return null; }
        });
        // SORT: Sorts array in-place (default: ascending)
        // Usage: sort(arr)
        define("sort", async (arr) => {
            if (this.isDKArray(arr)) {
                const slots = this.getHybridKeySlots(arr);
                const paired = arr.map((value, i) => ({ value, key: slots[i] }));
                paired.sort((a, b) => {
                    if (typeof a.value === 'number' && typeof b.value === 'number') return a.value - b.value;
                    return String(a.value).localeCompare(String(b.value));
                });
                for (let i = 0; i < paired.length; i++) {
                    arr[i] = paired[i].value;
                    slots[i] = paired[i].key ?? null;
                }
                return arr;
            }
            if (!this.isDKWrapper(arr)) return arr;
            const base = this.getArrayBase(arr);
            
            // Extract, Sort, Splice
            const portion = arr.data.slice(base);
            portion.sort((a, b) => {
                // Numeric sort if possible, otherwise string sort
                if (typeof a === 'number' && typeof b === 'number') return a - b;
                return String(a).localeCompare(String(b));
            });
            
            arr.data.splice(base, portion.length, ...portion);
            return arr;
        });

        // DATE: Returns human readable date string
        // Usage: date() -> "10/24/2025, 4:30 PM"
        // Usage: date(timestamp)
        define("date", async (ts) => {
            const d = ts ? new Date(Number(ts)) : new Date();
            return d.toLocaleString();
        });
        // High-resolution timer for benchmarking
        define("now", async () => performance.now());
        // --- MATRIX ENGINE ---
        
        // Helper to spawn a new vector and register it for DK 1-based friendliness
        const createVec = (size) => {
            const v = new Float32Array(size);
            if (typeof __dk_window.dkArrayEnsure === 'function') __dk_window.dkArrayEnsure(v);
            return v;
        };

        // FIX: Updated to support raw TypedArrays instead of the old 'buf' wrappers
        define("dot_product", async (a, b) => {
            if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return 0;
            const len = Math.min(a.length, b.length);
            let sum = 0;
            for (let i = 0; i < len; i++) sum += a[i] * b[i];
            return sum;
        });

        // Add two vectors together: c = vec_add(a, b)
        define("vec_add", async (a, b) => {
            if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return null;
            const len = Math.min(a.length, b.length);
            const out = createVec(len);
            for (let i = 0; i < len; i++) out[i] = a[i] + b[i];
            return out;
        });

        // Subtract vector b from a: c = vec_sub(a, b)
        define("vec_sub", async (a, b) => {
            if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return null;
            const len = Math.min(a.length, b.length);
            const out = createVec(len);
            for (let i = 0; i < len; i++) out[i] = a[i] - b[i];
            return out;
        });

        // Multiply a vector by a single scalar number: c = vec_scale(a, 10)
        define("vec_scale", async (a, scalar) => {
            if (!ArrayBuffer.isView(a)) return null;
            const len = a.length;
            const s = Number(scalar) || 0;
            const out = createVec(len);
            for (let i = 0; i < len; i++) out[i] = a[i] * s;
            return out;
        });

        // Get the magnitude (length) of a vector: len = vec_mag(a)
        define("vec_mag", async (a) => {
            if (!ArrayBuffer.isView(a)) return 0;
            let sum = 0;
            for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
            return Math.sqrt(sum);
        });

        // Normalize a vector (scale it so its magnitude is exactly 1)
        define("vec_norm", async (a) => {
            if (!ArrayBuffer.isView(a)) return null;
            const len = a.length;
            let sum = 0;
            for (let i = 0; i < len; i++) sum += a[i] * a[i];
            const mag = Math.sqrt(sum);
            const out = createVec(len);
            if (mag === 0) return out; // Prevent division by zero
            for (let i = 0; i < len; i++) out[i] = a[i] / mag;
            return out;
        });

        // Get the spatial distance between two vectors
        define("vec_dist", async (a, b) => {
            if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return 0;
            const len = Math.min(a.length, b.length);
            let sum = 0;
            for (let i = 0; i < len; i++) {
                const diff = a[i] - b[i];
                sum += diff * diff;
            }
            return Math.sqrt(sum);
        });
        // Multiply a 1D Vector by a 2D Matrix (Array of Vectors)
        define("mat_mul", (vec, matrix) => {
            if (!ArrayBuffer.isView(vec)) return null;
            // Matrix should be a standard Array containing Float32Arrays
            const matBase = this.getArrayBase(matrix);
            const isWrap = this.isDKWrapper(matrix);
            const rows = isWrap ? matrix.data.slice(matBase) : matrix;
            
            if (!rows || rows.length === 0 || !ArrayBuffer.isView(rows[0])) return null;
            
            const inputSize = vec.length;
            const outputSize = rows[0].length;
            const out = createVec(outputSize);
            
            // Core neural network forward pass loop
            for (let outIdx = 0; outIdx < outputSize; outIdx++) {
                let sum = 0;
                for (let inIdx = 0; inIdx < inputSize; inIdx++) {
                    // Safe access in case matrix rows are uneven
                    const weight = rows[inIdx] ? (rows[inIdx][outIdx] || 0) : 0;
                    sum += vec[inIdx] * weight;
                }
                out[outIdx] = sum;
            }
            return out;
        });

        // Convert raw neural logits into percentage probabilities
        define("vec_softmax", (vec) => {
            if (!ArrayBuffer.isView(vec)) return null;
            const len = vec.length;
            const out = createVec(len);
            if (len === 0) return out;

            // 1. Find max for numerical stability (prevents Infinity errors)
            let maxVal = vec[0];
            for (let i = 1; i < len; i++) {
                if (vec[i] > maxVal) maxVal = vec[i];
            }

            // 2. Calculate exponentials and sum
            let sumExp = 0;
            for (let i = 0; i < len; i++) {
                const e = Math.exp(vec[i] - maxVal);
                out[i] = e;
                sumExp += e;
            }

            // 3. Normalize to probabilities
            for (let i = 0; i < len; i++) {
                out[i] = out[i] / sumExp;
            }
            return out;
        });
        // --- ADVANCED MATH & TRIGONOMETRY ---
        define("sin", Math.sin); 
        define("cos", Math.cos); 
        define("tan", Math.tan);
        define("asin", Math.asin); 
        define("acos", Math.acos); 
        define("atan2", Math.atan2);
        define("exp", Math.exp); 
        define("log", Math.log); 
        define("log10", Math.log10); 
        define("log2", Math.log2);
        define("trunc", Math.trunc);

        // --- ENVIRONMENT & UTILS ---
        define("rand", Math.random);
        define("rand_int", async (min, max) => Math.floor(Math.random() * (Number(max) - Number(min) + 1)) + Number(min));
        define("time", async () => Math.floor(Date.now() / 1000)); // Unix timestamp in seconds
        
        // Browser-safe wrappers for UI blocking calls
        define("input", async (msg) => {
            const promptText = String(msg || "");
            if (typeof prompt !== 'undefined') return prompt(promptText);
            if (this.host && typeof this.host.callCapability === "function") {
                let hasReadLine = false;
                try {
                    if (typeof this.host.hasCapability === "function") {
                        hasReadLine = !!(await this.host.hasCapability("read_line", {
                            fromPath: this.currentScriptPath
                        }));
                    } else if (this.host.capabilities instanceof Map) {
                        hasReadLine = this.host.capabilities.has("read_line");
                    } else if (this.host.capabilities && typeof this.host.capabilities === "object") {
                        hasReadLine = typeof this.host.capabilities.read_line === "function";
                    }
                } catch (_) {
                    hasReadLine = false;
                }
                if (hasReadLine) {
                    const result = await this.host.callCapability("read_line", [promptText], {
                        fromPath: this.currentScriptPath
                    });
                    return result === undefined ? null : result;
                }
            }
            return null; // Safe fallback if running outside a browser
        });
        define("alert", async (msg) => {
            if (typeof alert !== 'undefined') alert(String(msg || ""));
            else this.logger("[ALERT] " + this.stringify(msg)); // Fallback to console
        });

        define("set_base", async (b) => { this.globalBase = Number(b); return null; });
        define("get_base", async () => this.globalBase);

        // Native AI Sandbox Tools!
        define("sleep", async (ms) => {
            return new Promise(resolve => setTimeout(resolve, Number(ms)));
        });
        
        define("fetch_text", async (url) => {
            try {
                const response = await __dk_window.fetch(String(url));
                return await response.text();
            } catch(e) {
                return "Error: " + e.message;
            }
        });

        // Execute DK source in an isolated child VM using current runtime flags.
        define("run", async (source) => {
            const code = String(source == null ? "" : source);
            try {
                const LexerCtor =
                    this.Lexer ||
                    ((typeof Lexer !== "undefined") ? Lexer : null) ||
                    ((typeof __dk_window !== "undefined" && __dk_window.Lexer) ? __dk_window.Lexer : null);
                const ParserCtor =
                    this.Parser ||
                    ((typeof Parser !== "undefined") ? Parser : null) ||
                    ((typeof __dk_window !== "undefined" && __dk_window.Parser) ? __dk_window.Parser : null);
                const CompilerCtor =
                    this.Compiler ||
                    ((typeof Compiler !== "undefined") ? Compiler : null) ||
                    ((typeof __dk_window !== "undefined" && __dk_window.Compiler) ? __dk_window.Compiler : null);

                if (!LexerCtor || !ParserCtor || !CompilerCtor) {
                    throw this.makeDKError("run() unavailable in this host", {
                        type: "HostError",
                        code: "RUN_UNAVAILABLE",
                        location: "run()"
                    });
                }

                const child = new VM(this.logger);
                child.MOCK_FS = this.MOCK_FS;
                child.host = this.host;
                child.currentScriptPath = this.currentScriptPath;
                child.Lexer = LexerCtor;
                child.Parser = ParserCtor;
                child.Compiler = CompilerCtor;
                child.Minifier = this.Minifier;
                child.DKMin = this.DKMin;
                child.setDKPSigils(this.getDKPSigilList(), "run:sigils");
                child.setRuntimeFlags(this.globals.get("__dk_flags"));

                const lexer = new LexerCtor(code);
                const tokens = lexer.tokenize();
                const parser = new ParserCtor(tokens, null, "RUN");
                const ast = parser.parse();
                this.lastRunMeta = {
                    parseWarnings: Array.isArray(parser.warnings) ? parser.warnings.length : 0,
                    parseWarningMessages: Array.isArray(parser.warnings) ? parser.warnings.slice(0, 100) : []
                };
                const compiler = new CompilerCtor(null);
                const fn = compiler.compile(ast);
                return await child.interpret(fn);
            } catch (e) {
                throw this.coerceDKError(e, { location: "run()" });
            }
        });
        define("minify", async (source) => {
            const code = String(source == null ? "" : source);
            try {
                const MinifierCtor =
                    this.Minifier ||
                    ((typeof Minifier !== "undefined") ? Minifier : null) ||
                    ((typeof __dk_window !== "undefined" && __dk_window.Minifier) ? __dk_window.Minifier : null);
                if (!MinifierCtor) {
                    throw this.makeDKError("minify() unavailable in this host", {
                        type: "HostError",
                        code: "MINIFY_UNAVAILABLE",
                        location: "minify()"
                    });
                }
                const minifier = new MinifierCtor(code);
                return String(minifier.minify());
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "MinifierError",
                    code: "MINIFIER_ERROR",
                    location: "minify()"
                });
            }
        });
        define("DKMin", async (source) => {
            const code = String(source == null ? "" : source);
            try {
                const DKMinCtor =
                    this.DKMin ||
                    ((typeof DKMin !== "undefined") ? DKMin : null) ||
                    ((typeof __dk_window !== "undefined" && __dk_window.DKMin) ? __dk_window.DKMin : null);
                if (!DKMinCtor) {
                    throw this.makeDKError("DKMin() unavailable in this host", {
                        type: "HostError",
                        code: "DKMIN_UNAVAILABLE",
                        location: "DKMin()"
                    });
                }
                const minifier = new DKMinCtor(code);
                return String(minifier.minify());
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "MinifierError",
                    code: "MINIFIER_ERROR",
                    location: "DKMin()"
                });
            }
        });
        define("mini", async (source) => {
            const code = String(source == null ? "" : source);
            try {
                const MinifierCtor =
                    this.Minifier ||
                    ((typeof Minifier !== "undefined") ? Minifier : null) ||
                    ((typeof __dk_window !== "undefined" && __dk_window.Minifier) ? __dk_window.Minifier : null);
                if (!MinifierCtor) {
                    throw this.makeDKError("mini() unavailable in this host", {
                        type: "HostError",
                        code: "MINI_UNAVAILABLE",
                        location: "mini()"
                    });
                }
                const minifier = new MinifierCtor(code);
                return String(minifier.minify());
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "MinifierError",
                    code: "MINIFIER_ERROR",
                    location: "mini()"
                });
            }
        });
        define("run_meta", async () => this.toDKFlagValue(this.lastRunMeta || { parseWarnings: 0, parseWarningMessages: [] }));
        define("DKP_sigils", async () => this.toDKFlagValue(this.getDKPSigilList()));
        define("DKP_define_sigil", async (sigil) => {
            try {
                return this.addDKPSigil(sigil, "DKP_define_sigil");
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "DKPError",
                    code: "DKP_INVALID_SIGIL",
                    location: "DKP_define_sigil"
                });
            }
        });
        define("DKP_remove_sigil", async (sigil) => {
            try {
                return this.removeDKPSigil(sigil, "DKP_remove_sigil");
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "DKPError",
                    code: "DKP_INVALID_SIGIL",
                    location: "DKP_remove_sigil"
                });
            }
        });
        define("DKP_reset_sigils", async () => this.toDKFlagValue(this.resetDKPSigils()));
        define("DKP_set_sigils", async (sigils) => {
            try {
                const jsSigils = this.hostValueToJS(sigils);
                if (!Array.isArray(jsSigils)) {
                    throw this.makeDKPError("DKP_set_sigils requires an array of sigils", "DKP_INVALID_SIGIL_STORE", "DKP_set_sigils");
                }
                return this.toDKFlagValue(this.setDKPSigils(jsSigils, "DKP_set_sigils"));
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "DKPError",
                    code: "DKP_INVALID_SIGIL_STORE",
                    location: "DKP_set_sigils"
                });
            }
        });

        define("DKP_pack", async (sigil, source) => {
            try {
                return this.packDKPPulse(sigil, source);
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "DKPError",
                    code: "DKP_INVALID_PACKET",
                    location: "DKP_pack"
                });
            }
        });

        define("DKP_unpack", async (packet) => {
            try {
                return this.unpackDKPPulse(packet, "DKP_unpack");
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "DKPError",
                    code: "DKP_INVALID_PACKET",
                    location: "DKP_unpack"
                });
            }
        });

        define("DKP_send", async (channel, packet) => {
            const channelName = String(channel == null ? "" : channel).trim();
            try {
                if (!channelName) {
                    throw this.makeDKPError("DKP channel must be a non-empty string", "DKP_INVALID_CHANNEL", "DKP_send");
                }
                this.unpackDKPPulse(packet, "DKP_send");
                if (!this.host || typeof this.host.sendDKPPulse !== "function") {
                    throw this.makeDKPError(`DKP channel '${channelName}' is unavailable in this host`, "DKP_UNKNOWN_CHANNEL", "DKP_send");
                }
                const delivered = await this.host.sendDKPPulse(channelName, String(packet), {
                    fromPath: this.currentScriptPath
                });
                if (!delivered) {
                    throw this.makeDKPError(`DKP channel '${channelName}' is unknown or has no active listeners`, "DKP_UNKNOWN_CHANNEL", "DKP_send");
                }
                return this.buildDKPMap({
                    ok: true,
                    code: "DKP_SENT",
                    channel: channelName
                });
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "DKPError",
                    code: "DKP_SEND_FAILED",
                    location: "DKP_send"
                });
            }
        });

        define("DKP_listen", async (channel, handler) => {
            const channelName = String(channel == null ? "" : channel).trim();
            try {
                if (!channelName) {
                    throw this.makeDKPError("DKP channel must be a non-empty string", "DKP_INVALID_CHANNEL", "DKP_listen");
                }
                if (!(handler instanceof __dk_window.NativeFunction) && !(handler instanceof __dk_window.ObjClosure)) {
                    throw this.makeDKPError("DKP_listen requires a DK function handler", "DKP_INVALID_HANDLER", "DKP_listen");
                }
                if (!this.host || typeof this.host.listenDKPChannel !== "function") {
                    throw this.makeDKPError(`DKP channel '${channelName}' cannot be listened to in this host`, "DKP_LISTEN_FAILED", "DKP_listen");
                }
                const listenerId = this.host.listenDKPChannel(channelName, async (packetText, resolvedChannel) => {
                    const pulse = this.unpackDKPPulse(packetText, "DKP_listen");
                    this.setMapValue(pulse, "channel", String(resolvedChannel == null ? channelName : resolvedChannel));
                    await this.executeClosure(handler, [pulse]);
                }, {
                    fromPath: this.currentScriptPath
                });
                return listenerId;
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "DKPError",
                    code: "DKP_LISTEN_FAILED",
                    location: "DKP_listen"
                });
            }
        });

        define("DKP_unlisten", async (listenerId) => {
            try {
                if (!this.host || typeof this.host.unlistenDKPChannel !== "function") {
                    throw this.makeDKPError("DKP listeners are unavailable in this host", "DKP_UNLISTEN_FAILED", "DKP_unlisten");
                }
                return !!(await this.host.unlistenDKPChannel(listenerId));
            } catch (e) {
                throw this.coerceDKError(e, {
                    type: "DKPError",
                    code: "DKP_UNLISTEN_FAILED",
                    location: "DKP_unlisten"
                });
            }
        });

         // --- GLOBAL CONSTANTS ---
        // Put these at the very bottom of initNativeFunctions()
        this.globals.set("PI", Math.PI);
        this.globals.set("E", Math.E);
        this.globals.set("INFINITY", Infinity);
        this.globals.set("NaN", NaN);
    }

    async interpret(functionObj) {
        const ObjClosure = __dk_window.ObjClosure;
        const closure = new ObjClosure(functionObj);
        this.pushValue(closure); 
        this.pushFrame(closure, 0); 
        this.assertRuntimeState("interpret:entry");
        const result = await this.run(0, 0);
        this.assertRuntimeState("interpret:exit");
        return result;
    }

    pushFrame(closure, argCount) {
        if (this.sp >= this.stackSize) throw new Error("Stack Overflow");
        const newBp = this.sp - argCount - 1;
        if (newBp < this.bp) {
            const name = closure?.function?.name || "<anon>";
            throw new Error(`Frame base underflow for ${name} (newBp=${newBp}, bp=${this.bp}, sp=${this.sp}, argCount=${argCount})`);
        }
        const CallFrame = __dk_window.CallFrame;
        const frame = new CallFrame(closure, 0); 
        frame.bp = newBp; 
        frame.receiver = null;
        this.frames[this.frameCount++] = frame;
        this.bp = newBp;
        this.assertRuntimeState(`pushFrame:${closure?.function?.name || "<anon>"}`, frame);
    }

    findMethodInChain(klass, name) {
        let cur = klass;
        while (cur) {
            if (cur.methods && cur.methods.has(name)) return cur.methods.get(name);
            cur = cur.superClass;
        }
        return null;
    }

    isInstanceOf(inst, klass) {
        let k = inst.klass;
        while (k) {
            if (k === klass) return true;
            k = k.superClass;
        }
        return false;
    }

    captureUpvalue(localIndex) {
        const ObjUpvalue = __dk_window.ObjUpvalue;
        let prevUpvalue = null;
        let upvalue = this.openUpvalues;
        while (upvalue != null && upvalue.location > localIndex) {
            prevUpvalue = upvalue;
            upvalue = upvalue.next;
        }
        if (upvalue != null && upvalue.location === localIndex) return upvalue;
        let createdUpvalue = new ObjUpvalue(localIndex);
        createdUpvalue.next = upvalue;
        if (prevUpvalue == null) this.openUpvalues = createdUpvalue;
        else prevUpvalue.next = createdUpvalue;
        return createdUpvalue;
    }

    closeUpvalues(last) {
        while (this.openUpvalues != null && this.openUpvalues.location >= last) {
            let upvalue = this.openUpvalues;
            upvalue.closed = this.stack[upvalue.location]; 
            upvalue.location = -1; 
            upvalue.isClosed = true;
            this.openUpvalues = upvalue.next;
        }
    }

    async run(targetFrameCount = 0, targetSp = null) {
        const OPS = __dk_window.OPS;
        const ObjClosure = __dk_window.ObjClosure;
        const NativeFunction = __dk_window.NativeFunction;

        if (this.frameCount === 0) return null;

        // Use local variables for hot-loop performance
        let frame = this.frames[this.frameCount - 1];
        let code = frame.closure.function.code;
        let constants = frame.closure.function.constants;
        let ip = frame.ip; 
        
        let opCount = 0;
        let maxOps = 50000000; // Higher default to avoid false positives on large suites.
        try {
            const flags = this.globals.get("__dk_flags");
            let raw = null;
            if (flags && flags.type === "arr" && flags.data) {
                raw = flags.data["^maxOps"];
            } else if (flags && typeof flags === "object") {
                raw = flags.maxOps;
            }
            const parsed = Number(raw);
            if (Number.isFinite(parsed) && parsed >= 100000) {
                maxOps = Math.floor(parsed);
            }
        } catch (_) {
            // Keep default maxOps if flags are unavailable or malformed.
        }
        const MAX_OPS = maxOps;
        this.assertRuntimeState(`run:start(target=${targetFrameCount})`, frame);

        // CRITICAL FIX: Loop correctly and track targetFrameCount for recursion
       while (ip < code.length) {
            const opIp = ip;
            const op = code[ip++];

            // Sync the VM's state so modules and error catchers stay aligned
            this.ip = ip; 
            frame.ip = ip;

            const spBefore = this.sp;
            const bpBefore = this.bp;
            if (this.debug && ip >= code.length) {
                this.dumpStack(`IP out of bounds (ip=${ip}, len=${code.length})`, true);
                return null;
            }
            const OP_NAMES = __dk_window.OP_NAMES || {};
            this.lastOpCode = op;
            this.lastOpIp = opIp;
            this.lastOpName = OP_NAMES[op] || ("OP_" + op);

            if (this.traceExecution) this.trace(op, code, opIp, constants);
            
            if (++opCount > MAX_OPS) {
                const line = (frame && frame.closure.function.codeLines) ? frame.closure.function.codeLines[ip] : "?";
                this.logger(`[VM] Runaway Loop Detected at ip=${ip} line=${line}`);
                this.dumpStack(`Runaway Loop Detected (> ${MAX_OPS} instructions)`, true);
                throw new Error(`Runaway Loop Detected (> ${MAX_OPS} instructions) at Line: ${line}`);
            }

            try {
                switch (op) {
                    case OPS.HALT: return this.stack[this.sp - 1];
                    case OPS.CONST: this.pushValue(constants[code[ip++]]); break;
                    case OPS.GET_LOCAL: this.pushValue(this.stack[this.bp + 1 + code[ip++]]); break;
                    case OPS.SET_LOCAL: this.setStack(this.bp + 1 + code[ip++], this.stack[this.sp - 1]); break;
                    
                    case OPS.GET_GLOBAL: {
    const name = constants[code[ip++]];
    const receiver = frame.receiver;
    
    if (receiver instanceof __dk_window.ObjInstance && receiver.fields.has(name)) {
        this.pushValue(receiver.fields.get(name));
        break;
    }
    if (this.globals.has(name)) {
        this.pushValue(this.globals.get(name));
        break;
    }
    if (this.globalFunctions.has(name)) {
        this.pushValue(this.globalFunctions.get(name));
        break;
    }
    if (frame.closure && frame.closure.moduleGlobals instanceof Map && frame.closure.moduleGlobals.has(name)) {
        this.pushValue(frame.closure.moduleGlobals.get(name));
        break;
    }
    if (this.systemTools.has(name)) {
        this.pushValue(this.systemTools.get(name));
        break;
    }
    throw new Error(`Undefined global '${name}'`);
}

case OPS.SET_GLOBAL: {
                        const name = constants[code[ip++]];
                        const value = this.stack[this.sp - 1];

                        if (frame && frame.receiver instanceof __dk_window.ObjInstance) {
                            frame.receiver.fields.set(name, value);
                        } else {
                            if (this.systemTools.has(name)) {
                                const isFn = value && (value.type === 'function' || value instanceof __dk_window.NativeFunction || typeof value.fn === 'function');
                                if (isFn) throw new Error(`Cannot override native system tool '${name}' with a function.`);
                            }
                            
                            const isFunctionVal = value instanceof __dk_window.ObjClosure || value instanceof __dk_window.ObjFunction;
                            if (isFunctionVal) {
                                this.globalFunctions.set(name, value);
                            } else {
                                this.globals.set(name, value);
                            }
                        }
                        break;
                    }
                    case OPS.GET_FUNCTION_GLOBAL: {
                        const name = constants[code[ip++]];
                        if (this.globalFunctions && this.globalFunctions.has(name)) {
                            this.pushValue(this.globalFunctions.get(name));
                        } else if (this.globals.has(name)) {
                            this.pushValue(this.globals.get(name));
                        } else {
                            throw new Error(`Undefined function '${name}'`);
                        }
                        break;
                    }
                    case OPS.GET_UPVALUE: {
                        const slot = code[ip++];
                        const upval = frame.closure.upvalues[slot];
                        this.pushValue(upval.isClosed ? upval.closed : this.stack[upval.location]);
                        break;
                    }
                    case OPS.SET_UPVALUE: {
                        const slot = code[ip++];
                        const upval = frame.closure.upvalues[slot];
                        const val = this.stack[this.sp - 1];
                        if (upval.isClosed) upval.closed = val;
                        else this.stack[upval.location] = val;
                        break;
                    }
                    case OPS.CLOSE_UPVALUE: {
                        if (this.sp <= this.bp) {
                            throw new Error(`Stack underflow on CLOSE_UPVALUE @ ${opIp} (sp=${this.sp}, bp=${this.bp})`);
                        }
                        this.closeUpvalues(this.sp - 1);
                        this.sp--;
                        break;
                    }
                    case OPS.CLOSURE: {
                        const func = constants[code[ip++]];
                        const closure = new ObjClosure(func);
                        closure.moduleGlobals = frame.closure ? frame.closure.moduleGlobals : null;
                        this.pushValue(closure);
                        for (let i = 0; i < func.upvalueCount; i++) {
                            const isLocal = code[ip++];
                            const index = code[ip++];
                            if (isLocal) closure.upvalues.push(this.captureUpvalue(this.bp + 1 + index));
                            else closure.upvalues.push(frame.closure.upvalues[index]);
                        }
                        break;
                    }
                    case OPS.POP: {
                        this.popValue();
                        break;
                    }
                    case OPS.DUP: this.pushValue(this.stack[this.sp - 1]); break;
                    case OPS.JUMP_FALSE: { const offset = (code[ip] << 8) | code[ip + 1]; ip += 2; if (!this.stack[--this.sp]) ip += offset; break; }
                    case OPS.JUMP: { const offset = (code[ip] << 8) | code[ip + 1]; ip += 2; ip += offset; break; }
                    case OPS.LOOP: { const offset = (code[ip] << 8) | code[ip + 1]; ip += 2; ip -= offset; break; }
                    case OPS.CALL: {
                        const argCount = code[ip++];
                        const calleeIndex = this.sp - 1 - argCount;
                        let callee = this.stack[calleeIndex];
                        
                        // Defensive Module Check: Only check .data if callee is a DK Object ('arr')
                        if (callee && typeof callee === 'object' && callee.type === 'arr' && callee._isModule) {
                            if (callee.data) {
                                const internalMember = callee.data["^" + callee._moduleName];
                                if (internalMember) {
                                    callee = internalMember;
                                    this.stack[calleeIndex] = callee; 
                                }
                            }
                        }

                        // SENSORY AUTO-UNWRAP (ARGUMENTS)
                        for (let i = this.sp - argCount; i < this.sp; i++) {
                            const val = this.stack[i];
                            // Check if the value is a NativeFunction object named "restructure"
                            if (val && typeof val === 'object' && val.isNative === true && val.name === "restructure") {
                                this.stack[i] = await val.fn(""); 
                            }
                        }

                        // NativeFunction values are directly callable. Module member
                        // auto-resolution is handled above for DK module objects only.

                        if (callee instanceof NativeFunction) {
                            const args = [];
                            for (let i = this.sp - argCount; i < this.sp; i++) args.push(this.stack[i]);
                            let result = callee.fn(...args);
                            
                            // MAGIC PAUSE: If the native tool fetches data, wait for it!
                            if (result instanceof Promise) result = await result; 
                            
                            this.sp -= (argCount + 1); 
                            this.pushValue(result);
                        } 
                        else if (callee instanceof ObjClosure) {
                            if (callee.receiver) {
                                for (let i = this.sp; i > calleeIndex + 1; i--) this.stack[i] = this.stack[i - 1];
                                this.stack[calleeIndex + 1] = callee.receiver;
                                this.sp++;
                                frame.ip = ip;
                                this.pushFrame(callee, argCount + 1);
                                frame = this.frames[this.frameCount - 1];
                                frame.receiver = callee.receiver;
                                code = frame.closure.function.code;
                                constants = frame.closure.function.constants;
                                ip = 0;
                            } else {
                                frame.ip = ip;
                                this.pushFrame(callee, argCount);
                                frame = this.frames[this.frameCount - 1];
                                code = frame.closure.function.code;
                                constants = frame.closure.function.constants;
                                ip = 0;
                            }
                        }
                        else if (callee instanceof __dk_window.ObjClass) {
                            const klass = callee;
                            const inst = new __dk_window.ObjInstance(klass);
                            if (!inst.fields) inst.fields = new Map();

                            const init = this.findMethodInChain(klass, "in");
                            if (init) {
                                if (init instanceof NativeFunction) {
                                    const args = [inst, ...this.stack.slice(this.sp - argCount, this.sp)];
                                    init.fn(...args);
                                    this.sp = calleeIndex + 1;
                                    this.stack[calleeIndex] = inst;
                                } else if (init instanceof ObjClosure) {
                                    for (let i = this.sp; i > calleeIndex + 1; i--) this.stack[i] = this.stack[i - 1];
                                    this.stack[calleeIndex] = init;       
                                    this.stack[calleeIndex + 1] = inst;   
                                    this.sp++;                            
                                    frame.ip = ip;
                                    this.pushFrame(init, argCount + 1);   
                                    frame = this.frames[this.frameCount - 1];
                                    frame.receiver = inst; 
                                    code = frame.closure.function.code;
                                    constants = frame.closure.function.constants;
                                    ip = 0;
                                }
                            } else {
                                this.sp = calleeIndex + 1;
                                this.stack[calleeIndex] = inst;
                            }
                        }
                        else if (argCount === 0 && callee && callee.type === 'arr' && callee.data && (Object.prototype.hasOwnProperty.call(callee.data, '^last') || Object.prototype.hasOwnProperty.call(callee.data, 'last'))) {
                            this.sp = calleeIndex + 1;
                            this.stack[calleeIndex] = callee;
                        }
                        else { throw new Error(`Attempt to call non-function: ${this.stringify(callee)}`); }
                        break;
                    }
                    case OPS.INVOKE: {
                        const methodNameIdx = code[ip++];
                        const argCount = code[ip++];
                        const methodName = constants[methodNameIdx];
                        const receiverIndex = this.sp - 1 - argCount;
                        let receiver = this.stack[receiverIndex];
                        
                        // SENSORY AUTO-UNWRAP (RECEIVER)
                        if (receiver && typeof receiver === 'object' && receiver.isNative === true && receiver.name === "restructure") {
                            receiver = await receiver.fn("");
                            this.stack[receiverIndex] = receiver;
                        }
                        
                        // SENSORY AUTO-UNWRAP (ARGUMENTS)
                        for (let i = this.sp - argCount; i < this.sp; i++) {
                            const val = this.stack[i];
                            if (val && typeof val === 'object' && val.isNative === true && val.name === "restructure") {
                                this.stack[i] = await val.fn(""); 
                            }
                        }
                        const callNative = async (callee, passReceiver, receiverOverride) => {
                            const recv = (receiverOverride !== undefined) ? receiverOverride : receiver;
                            const args = [];
                            if (passReceiver) args.push(recv);
                            for (let i = this.sp - argCount; i < this.sp; i++) args.push(this.stack[i]);
                            let result = callee.fn(...args);
                            if (result instanceof Promise) result = await result; // MAGIC PAUSE
                            this.sp = receiverIndex;
                            this.pushValue(result);
                        };

                        const callClosure = (callee, passReceiver, receiverOverride) => {
                            const recv = (receiverOverride !== undefined) ? receiverOverride : receiver;
                            let callArgCount = argCount;
                            if (passReceiver) {
                                for (let i = this.sp; i > receiverIndex + 1; i--) this.stack[i] = this.stack[i - 1];
                                this.stack[receiverIndex + 1] = recv;
                                this.sp++;
                                callArgCount++;
                            }
                            this.stack[receiverIndex] = callee;
                            frame.ip = ip;
                            this.pushFrame(callee, callArgCount);
                            frame = this.frames[this.frameCount - 1];
                            frame.receiver = passReceiver ? recv : null;
                            code = frame.closure.function.code;
                            constants = frame.closure.function.constants;
                            ip = 0;
                        };

                        if (this.isDKWrapper(receiver) || this.isDKArray(receiver)) {
                            const prop = this.getMapValue(receiver, methodName);
                            if (prop instanceof NativeFunction || prop instanceof ObjClosure) {
                                const passReceiver = (argCount === 0);
                                if (prop instanceof NativeFunction) await callNative(prop, passReceiver);
                                else callClosure(prop, passReceiver);
                                break;
                            }
                        }

                        if (receiver instanceof __dk_window.ObjInstance) {
                            const prop = receiver.fields.get(methodName) || this.findMethodInChain(receiver.klass, methodName);
                            if (prop instanceof NativeFunction || prop instanceof ObjClosure) {
                                if (prop instanceof NativeFunction) await callNative(prop, true);
                                else callClosure(prop, true);
                                break;
                            }
                        } else if (receiver instanceof __dk_window.ObjClass) {
                            const prop = this.findMethodInChain(receiver, methodName);
                            if (prop instanceof NativeFunction || prop instanceof ObjClosure) {
                                let effectiveReceiver = receiver;
                                
                                // FIX: Bind 'this' to the current instance (always at bp + 1 in methods)
                                const potentialThis = this.stack[frame.bp + 1]; 
                                if (potentialThis instanceof __dk_window.ObjInstance) {
                                    let curr = potentialThis.klass;
                                    while (curr) {
                                        if (curr === receiver) { 
                                            effectiveReceiver = potentialThis; 
                                            break; 
                                        }
                                        curr = curr.superClass;
                                    }
                                }
                                
                                this.stack[receiverIndex] = effectiveReceiver;

                                if (prop instanceof NativeFunction) await callNative(prop, true, effectiveReceiver);
                                else callClosure(prop, true, effectiveReceiver);
                                break;
                            }
                        }
                        
                        if (this.globals.has(methodName)) {
                            const callee = this.globals.get(methodName);
                            if (callee instanceof NativeFunction) {
                                await callNative(callee, true);
                                break;
                            }
                        }

                        this.sp = receiverIndex;
                        this.pushValue(null);
                        break;
                    }
                    case OPS.RETURN: {

                        const result = this.popValue();
    
                        // Capture the return value on the active closure if it exists
                        if (frame.closure instanceof __dk_window.ObjClosure) {
                            frame.closure.lastResult = result;
                        }
                        
                        const fnName = frame.closure.function.name;

                        let finalResult = result;
                        if (frame.isModule) {
                            finalResult = result;
                            this.globals = frame.previousGlobals;
                        }
                        this.closeUpvalues(frame.bp); 
                        this.frameCount--;
                        this.pruneDeadLoopState(this.frameCount);
                        this.pruneDeadTryState(this.frameCount);

                        // === 2. THE NESTED EXIT FIX ===
                        if (this.frameCount === targetFrameCount) { 
                            if (targetSp !== null) {
                                this.sp = targetSp;
                            } else if (targetFrameCount === 0) {
                                this.sp--; // Normal script exit
                            } else {
                                this.sp = frame.bp; // Nested exit: clean up the closure args
                            }
                            this.bp = this.frameCount > 0 ? this.frames[this.frameCount - 1].bp : 0;
                            this.assertRuntimeState(`RETURN:${fnName}:target-exit`);
                            return finalResult; 
                        }

                        this.sp = frame.bp; 
                        this.pushValue(finalResult);
                        frame = this.frames[this.frameCount - 1];
                        this.bp = frame.bp;
                        code = frame.closure.function.code;
                        constants = frame.closure.function.constants;
                        ip = frame.ip;
                        this.assertRuntimeState(`RETURN:${fnName}:resume`, frame);
                        break;
                    }
                    case OPS.ADD: { const b = this.stack[--this.sp]; const a = this.stack[--this.sp]; if ((typeof a === 'string' || (a && typeof a === 'object')) || (typeof b === 'string' || (b && typeof b === 'object'))) { this.pushValue(this.stringify(a) + this.stringify(b)); } else { this.pushValue(a + b); } break; }
                    case OPS.ADD_ASSIGN: {
                        const b = this.stack[--this.sp];
                        const a = this.stack[--this.sp];
                        if (this.mergeCollectionInto(a, b)) {
                            this.pushValue(a);
                        } else if ((typeof a === 'string' || (a && typeof a === 'object')) || (typeof b === 'string' || (b && typeof b === 'object'))) {
                            this.pushValue(this.stringify(a) + this.stringify(b));
                        } else {
                            this.pushValue(a + b);
                        }
                        break;
                    }
                    case OPS.SUB: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] - b); break; }
                    case OPS.MUL: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] * b); break; }
                    case OPS.DIV: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] / b); break; }
                    case OPS.MOD: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] % b); break; }
                    case OPS.BIT_AND: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] & b); break; }
                    case OPS.BIT_OR:  { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] | b); break; }
                    case OPS.BIT_XOR: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] ^ b); break; }
                    case OPS.NOT: { this.setStack(this.sp - 1, !this.stack[this.sp - 1]); break; }
                    case OPS.AND: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] && b); break; }
                    case OPS.OR: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, this.stack[this.sp - 1] || b); break; }
                    case OPS.EQ: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, (this.stack[this.sp - 1] == b)); break; }
                    case OPS.NEQ:{ const b = this.stack[--this.sp]; this.setStack(this.sp - 1, (this.stack[this.sp - 1] != b)); break; }
                    case OPS.LT: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, (this.stack[this.sp - 1] < b)); break; }
                    case OPS.GT: { const b = this.stack[--this.sp]; this.setStack(this.sp - 1, (this.stack[this.sp - 1] > b)); break; }
                    case OPS.LTE:{ const b = this.stack[--this.sp]; this.setStack(this.sp - 1, (this.stack[this.sp - 1] <= b)); break; }
                    case OPS.GTE:{ const b = this.stack[--this.sp]; this.setStack(this.sp - 1, (this.stack[this.sp - 1] >= b)); break; }
                    case OPS.DUP_SECOND: {
                        this.pushValue(this.stack[this.sp - 2]);
                        break;
                    }
                    case OPS.BUILD_ARRAY: {
                        const count = code[ip++];
                        const start = this.sp - count;
                        const items = [];
                        for (let i = 0; i < count; i++) {
                            items.push(this.stack[start + i]);
                        }
                        this.sp -= count;
                        const arr = (typeof __dk_window.dkArrayCreate === "function")
                            ? __dk_window.dkArrayCreate(items, 1)
                            : items;
                        if (!__dk_window.dkArrayCreate) {
                            Object.defineProperty(arr, "__dk_base", {
                                value: 1,
                                writable: true,
                                configurable: true,
                                enumerable: false
                            });
                        }
                        this.pushValue(arr);
                        break;
                    }
                    case OPS.BUILD_MAP: {
                        const count = code[ip++];
                        const arr = { type: 'arr', data: [null], _base: 1, _isMap: true };
                        const start = this.sp - (count * 2);
                        for (let i = 0; i < count; i++) {
                            const k = this.stack[start + (i * 2)];
                            const v = this.stack[start + (i * 2) + 1];
                            arr.data[this.normalizeMapKey(k)] = v;
                        }
                        this.sp -= (count * 2);
                        this.pushValue(arr);
                        break;
                    }
                    case OPS.BUILD_VECTOR: {
                        const count = code[ip++];
                        const vec = new Float32Array(count);
                        // Fill from stack (Reverse order because it's a stack)
                        for (let i = count - 1; i >= 0; i--) {
                            const val = this.popValue();
                            // Treat 'any' as NaN for mathematical masking
                            vec[i] = (val === 'any') ? NaN : Number(val || 0);
                        }
                        this.pushValue(vec);
                        break;
                    }
                    case OPS.ALIAS_KEY: {
                        const index = this.popValue();
                        const key = this.popValue();
                        const target = this.popValue();
                        if (this.isDKArray(target)) {
                            this.aliasHybridSlot(target, key, index);
                        } else if (this.isDKWrapper(target)) {
                            const existing = this.getArrayValue(target, index);
                            this.setMapValue(target, key, existing);
                        }
                        break;
                    }
                    case OPS.GET_INDEX: {
                        const index = this.stack[--this.sp];
                        let target = this.stack[--this.sp];
                        
                        // SENSORY AUTO-UNWRAP (INDEXING)
                        if (target && typeof target === 'object' && target.isNative && target.name === "restructure") {
                            target = await target.fn("");
                        }                       
                        if (ArrayBuffer.isView(target)) {
                            // FAST PATH: United Vector/Buffer Access
                            const idx = this.getIndexWithBase(index, this.getArrayBase(target));
                            this.pushValue((idx >= 0 && idx < target.length) ? target[idx] : null);
                        }
                        else if (target instanceof __dk_window.ObjInstance) {
                            let v = target.fields.get(index);
                            if (v === undefined && typeof index === "string") {
                                const alt = index.startsWith("^") ? index.slice(1) : ("^" + index);
                                v = target.fields.get(alt);
                            }
                            if (v === undefined) v = this.findMethodInChain(target.klass, index);
                            this.pushValue(v);
                        } else if (target instanceof __dk_window.ObjClass) {
                            const v = this.findMethodInChain(target, index) ?? null;
                            this.pushValue(v);
                        } else if (this.isDKWrapper(target)) {
                            if (typeof index === 'string') this.pushValue(this.getMapValue(target, index) ?? null);
                            else {
                                const val = this.getArrayValue(target, index);
                                this.pushValue(val === undefined ? null : val);
                            }
                        } else if (this.isDKArray(target)) {
                            if (typeof index === "number") {
                                const val = this.getArrayValue(target, index);
                                this.pushValue(val === undefined ? null : val);
                            } else if (typeof index === "string") this.pushValue(this.getMapValue(target, index) ?? null);
                            else this.pushValue(null);
                        } else if (typeof target === 'string') {
                            const idx = this.getIndexWithBase(index, this.globalBase);
                            this.pushValue((idx >= 0 && idx < target.length) ? target[idx] : null);
                        } else if (this.isStringView(target)) {
                            const str = String(target.text ?? "");
                            const idx = this.getIndexWithBase(index, Number(target._base ?? 1));
                            this.pushValue((idx >= 0 && idx < str.length) ? str[idx] : null);
                        } else {
                            this.pushValue(null);
                        }
                        break;
                    }
                    case OPS.SET_INDEX: {
                const val = this.popValue();
                const index = this.popValue();
                const target = this.popValue();

                if (target instanceof __dk_window.ObjInstance) {
                    target.fields.set(index, val);
                    if (typeof index === "string") {
                        const alt = index.startsWith("^") ? index.slice(1) : ("^" + index);
                        target.fields.set(alt, val);
                    }
                } else if (ArrayBuffer.isView(target)) {
                    this.setArrayValue(target, index, val);
                } else if (this.isDKWrapper(target)) {
                    if (typeof index === "number") {
                        this.setArrayValue(target, index, val);
                    } else if (typeof index === "string") {
                        this.setMapValue(target, index, val);
                    }
                } else if (this.isDKArray(target)) {
                    if (typeof index === "number") {
                        this.setArrayValue(target, index, val);
                    } else if (typeof index === "string") {
                        this.setMapValue(target, index, val);
                    }
                } else if (target && typeof target === 'object' && !(target instanceof __dk_window.ObjClass)) {
                    // Standard JS object fallback
                    target[index] = val;
                } else {
                    // FIX: This throw is required for Section 12's Error Handling tests to pass.
                    // If target is a number (1) or null, we MUST throw so the 'err' block catches it.
                    throw new Error(`Cannot set index '${index}' on non-collection of type: ${typeof target}`);
                }
                this.pushValue(val);
                break;
            }
                    case OPS.GET_INDEX_BASE: {
                        const baseArg = this.popValue(); 
                        const index = this.popValue();   
                        const target = this.popValue();  
                        const effectiveBase = Number(baseArg); 

                        if (typeof target === 'string') {
                            const idx = index - effectiveBase;
                            this.pushValue((idx >= 0 && idx < target.length) ? target[idx] : null);
                        } else if (target && target.type === 'strview') {
                            const idx = index - effectiveBase;
                            this.pushValue((idx >= 0 && idx < target.text.length) ? target.text[idx] : null);
                        } else if (ArrayBuffer.isView(target) || this.isDKArray(target) || this.isDKWrapper(target)) {
                            const val = this.getArrayValueAtBase(target, index, effectiveBase);
                            this.pushValue(val === undefined ? null : val);
                        } else {
                            this.pushValue({ type: 'val_view', value: target, _base: effectiveBase });
                        }
                        break;
                    }
                    case OPS.SET_INDEX_BASE: {
                        const base = this.popValue();
                        const index = this.popValue();
                        const target = this.popValue();
                        const val = this.popValue();

                        if (ArrayBuffer.isView(target) || this.isDKWrapper(target) || this.isDKArray(target)) {
                            this.setArrayValueAtBase(target, index, val, base);
                        }
                        this.pushValue(val);
                        break;
                    }
                    case OPS.SLICE: {
                        const end = this.stack[--this.sp];
                        const start = this.stack[--this.sp];
                        const target = this.stack[--this.sp];
                        
                        if (typeof target === 'string' || this.isStringView(target)) {
                            const str = this.isStringView(target) ? String(target.text ?? "") : target;
                            const base = this.isStringView(target) ? Number(target._base ?? 1) : 1;
                            const s = this.getIndexWithBase((start ?? base), base);
                            const e = (end === null || end === undefined) ? undefined : (this.getIndexWithBase(end, base) + 1);
                            this.pushValue(str.slice(s, e));
                        } 
                        // FIX: Added ArrayBuffer.isView to seamlessly support pos[1:3]
                        else if (this.isDKArray(target) || this.isDKWrapper(target) || ArrayBuffer.isView(target)) {
                            const base = this.getArrayBase(target);
                            const len = this.getArrayLength(target);
                            const sRaw = (start === null || start === undefined) ? base : Number(start);
                            const eRaw = (end === null || end === undefined) ? (len + base - 1) : Number(end);
                            
                            if (ArrayBuffer.isView(target)) {
                                // FAST PATH: TypedArray.slice() returns a new contiguous Vector buffer automatically
                                const out = target.slice(sRaw - base, eRaw - base + 1);
                                this.setArrayBase(out, base); // Preserve DK 1-based indexing
                                this.pushValue(out);
                            } else {
                                // Standard Array Path
                                const outItems = [];
                                for (let i = sRaw; i <= eRaw; i++) {
                                    const v = this.getArrayValue(target, i);
                                    outItems.push(v === undefined ? null : v);
                                }
                                const out = (typeof __dk_window.dkArrayCreate === "function")
                                    ? __dk_window.dkArrayCreate(outItems, 1)
                                    : outItems;
                                if (this.isDKArray(target) && this.isDKArray(out)) {
                                    this.copyHybridKeySlots(target, out, sRaw - base, eRaw - base + 1);
                                }
                                this.pushValue(out);
                            }
                        } else {
                            this.pushValue(null);
                        }
                        break;
                    }
                    case OPS.REBASE: {
                        const base = this.stack[--this.sp];
                        const target = this.stack[--this.sp];
                        
                        // FIX: Added ArrayBuffer.isView(target) so vectors/buffers can be rebased!
                        if (this.isDKArray(target) || this.isDKWrapper(target) || ArrayBuffer.isView(target)) {
                            this.setArrayBase(target, base);
                            this.pushValue(target);
                        } else if (typeof target === 'string') {
                            this.pushValue({ type: 'strview', text: target, _base: Number(base) });
                        } else if (this.isStringView(target)) {
                            target._base = Number(base);
                            this.pushValue(target);
                        } else {
                            this.pushValue(target);
                        }
                        break;
                    }
                    case OPS.BUILD_REGEX: {
                        const flags = this.stack[--this.sp];
                        const pattern = this.stack[--this.sp];
                        this.pushValue(new RegExp(pattern, flags || ""));
                        break;
                    }
                    case OPS.BUILD_RANGE: {
                        const step = this.stack[--this.sp];
                        const end = this.stack[--this.sp];
                        const start = this.stack[--this.sp];
                        this.pushValue({ start, end, step });
                        break;
                    }
                    case OPS.FOR_RANGE: {
                        const varIndex = code[ip++];
                        const range = this.stack[--this.sp];
                        const slot = frame.bp + 1 + varIndex;
                        this.stack[slot] = range.start;
                        this.loopStack.push({ varIndex, range, startIp: ip, frameBp: frame.bp, frameCount: this.frameCount });
                        this.assertRuntimeState("FOR_RANGE:push", frame);
                        break;
                    }
                    case OPS.FOR_RANGE_END: {
                        this.pruneDeadLoopState(this.frameCount);
                        if (this.loopStack.length === 0) break;
                        const loop = this.loopStack[this.loopStack.length - 1];
                        if (loop.frameCount !== this.frameCount) break;
                        const slot = loop.frameBp + 1 + loop.varIndex;
                        this.stack[slot] += loop.range.step;
                        const v = this.stack[slot];
                        const r = loop.range;
                        // Compiler stores adjusted end (end + step) in range.end.
                        // Use logical inclusive bound to avoid overshooting custom-step ranges.
                        const logicalEnd = r.end - r.step;
                        if ((r.step > 0 && v <= logicalEnd) || (r.step < 0 && v >= logicalEnd)) {
                            ip = loop.startIp;
                        } else {
                            this.loopStack.pop();
                        }
                        this.assertRuntimeState("FOR_RANGE_END", frame);
                        break;
                    }
                    case OPS.BOOL_SELECT: {
                        const f = this.stack[--this.sp];
                        const t = this.stack[--this.sp];
                        const c = this.stack[--this.sp];
                        this.pushValue(c ? t : f);
                        break;
                    }
                    case OPS.UNPACK: {
                        const count = code[ip++];
                        const arr = this.stack[--this.sp];
                        for (let i = 0; i < count; i++) {
                            const val = (this.isDKArray(arr) || this.isDKWrapper(arr))
                                ? this.getArrayValue(arr, i + 1)
                                : null;
                            this.pushValue(val === undefined ? null : val);
                        }
                        break;
                    }
                    case OPS.BUILD_CLASS: {
                        const name = constants[code[ip++]];
                        const superClass = this.stack[--this.sp];
                        const klass = new __dk_window.ObjClass(name, superClass);
                        this.pushValue(klass);
                        break;
                    }
                    case OPS.METHOD_DEF: {
                        const name = constants[code[ip++]];
                        const closure = this.stack[--this.sp];
                        const klass = this.stack[this.sp - 1];
                        if (klass && klass.methods) klass.methods.set(name, closure);
                        break;
                    }
                    case OPS.GET_PROP: {
                        const name = constants[code[ip++]];
                        const target = this.stack[--this.sp];
                        
                        if (target instanceof __dk_window.ObjInstance) {
                            if (target.fields.has(name)) {
                                this.pushValue(target.fields.get(name));
                            } else if (target.klass?.methods?.has(name)) {
                                const method = target.klass.methods.get(name);
                                const bound = new ObjClosure(method.function);
                                bound.upvalues = Array.isArray(method.upvalues) ? method.upvalues.slice() : [];
                                bound.moduleGlobals = method.moduleGlobals || null;
                                bound.receiver = target;
                                this.pushValue(bound);
                            } else {
                                this.pushValue(null);
                            }
                        } else if (this.isDKWrapper(target) || this.isDKArray(target)) {
                            this.pushValue(this.getMapValue(target, name) ?? null);
                        } else {
                            this.pushValue(null);
                        }
                        break;
                    }
                    case OPS.SET_PROP: {
                        const name = constants[code[ip++]];
                        const val = this.stack[--this.sp];
                        const target = this.stack[--this.sp];
                        
                        if (target instanceof __dk_window.ObjInstance) {
                            target.fields.set(name, val);
                        } else if (target instanceof __dk_window.ObjClass) {
                            target[name] = val;
                        } else if (this.isDKWrapper(target) || this.isDKArray(target)) {
                            this.setMapValue(target, name, val);
                        } else if (target && typeof target === 'object') {
                            target[name] = val;
                        }
                        this.pushValue(val);
                        break;
                    }          
              
                    case OPS.IMPORT: {
                        const pathVal = this.stack[--this.sp];
                        try {
                            const module = this.loadModule(pathVal);
                            if (this.isDKWrapper(module)) {
                                const parts = pathVal.split('/');
                                module._moduleName = parts[parts.length - 1];
                            }
                            this.pushValue(module);
                        } catch (err) {
                            throw this.coerceDKError(err, {
                                location: `import:${String(pathVal || "")}`
                            });
                        }
                        break;
                    }

                    case OPS.BUILD_NEURAL: {
                        const cases = this.popValue();      
                        const withData = this.popValue();   
                        const terrain = this.popValue();    
                        const limit = this.popValue();      
                        const weightFile = this.popValue(); 

                        // FIX: Do NOT use Array.from! Return raw buffers for C++ level iteration speed.
                        const asList = (val) => {
                            if (ArrayBuffer.isView(val)) return val; 
                            if (this.isDKWrapper(val) || this.isDKArray(val)) {
                                const base = this.getArrayBase(val);
                                const len = this.getArrayLength(val);
                                const out = [];
                                for (let i = 0; i < len; i++) {
                                    const v = this.getArrayValue(val, base + i);
                                    out.push(v === undefined ? null : v);
                                }
                                return out;
                            }
                            if (Array.isArray(val)) return val;
                            return [];
                        };

                        const inputList = asList(withData);
                        const terrainRows = asList(terrain);

                        if (!withData || (!Array.isArray(inputList) && !ArrayBuffer.isView(inputList))) {
                            throw this.makeDKError("Neural WITH input data is invalid or missing dimensions", {
                                type: "NeuralError",
                                code: "NEURAL_MATCH_ERROR",
                                location: "neural:with"
                            });
                        }
                        
                        let winningLabel = "fallback";
                        let maxScore = 0;
                        let actionResult = null;
                        
                        if (inputList.length > 0) {
                            // Because terrainRows can be standard arrays holding Vectors, we use standard map/forEach
                            terrainRows.forEach((row) => {
                                let rowScore = 0;
                                let activeSlots = 0;
                                let rowWeights = null;
                                let rowLabel = null;

                                if (this.isDKWrapper(row) || this.isDKArray(row)) {
                                    rowWeights = this.getArrayValue(row, 1);
                                    rowLabel = this.getArrayValue(row, 2);
                                } else if (Array.isArray(row)) {
                                    rowWeights = row[0];
                                    rowLabel = row[1];
                                } else if (row && typeof row === 'object') {
                                    rowWeights = row.weights ?? row[0];
                                    rowLabel = row.label ?? row[1];
                                }

                                const weights = asList(rowWeights);
                                if (weights.length === 0) return;

                                // SIMD FAST PATH: Standard for-loop avoids JS callback overhead
                                for (let i = 0; i < weights.length; i++) {
                                    const target = weights[i];
                                    // Treat NaN (Float32 any) or string 'any' as masks
                                    const isAnyMask = target === 'any' || (typeof target === 'number' && Number.isNaN(target)) || (target && target.type === 'Var' && target.name === 'any');
                                    if (isAnyMask) continue;
                                    
                                    const actual = Number(inputList[i] || 0);
                                    const ideal = Number(target || 0);
                                    
                                    rowScore += (100 - Math.abs(actual - ideal));
                                    activeSlots++;
                                }

                                const finalScore = activeSlots > 0 ? (rowScore / activeSlots) : 0;
                                if (finalScore > maxScore) {
                                    maxScore = finalScore;
                                    winningLabel = rowLabel ?? "fallback";
                                }
                            });
                        }

                        if (maxScore < Number(limit || 0)) winningLabel = "fallback";

                        const caseRows = asList(cases);
                        const getCaseLabel = (c) => {
                            if (this.isDKWrapper(c) || this.isDKArray(c)) return this.getArrayValue(c, 1);
                            if (Array.isArray(c)) return c[0];
                            if (c && typeof c === 'object') return c.label ?? c[0];
                            return null;
                        };
                        const getCaseAction = (c) => {
                            if (this.isDKWrapper(c) || this.isDKArray(c)) return this.getArrayValue(c, 2);
                            if (Array.isArray(c)) return c[1];
                            if (c && typeof c === 'object') return c.action ?? c[1];
                            return null;
                        };
                        
                        const match = caseRows.find(c => getCaseLabel(c) === winningLabel) || caseRows.find(c => getCaseLabel(c) === 'fallback');
                        if (match) {
                            const action = getCaseAction(match);
                            actionResult = (action instanceof __dk_window.ObjClosure || action instanceof __dk_window.NativeFunction) 
                                ? await this.executeInternal(action) 
                                : action;
                        }

                        if (this.logger) {
                            try {
                                this.logger(`[NEURAL-TRACE] inputs=${this.stringify(inputList)} terrainRows=${terrainRows.length} cases=${caseRows.length} winner=${this.stringify(winningLabel)} score=${this.stringify(maxScore)} action=${this.stringify(actionResult)}`);
                            } catch (_) {}
                        }

                        const neuralObj = { type: 'arr', data: [null], _base: 1 };
                        neuralObj.data['^last'] = winningLabel;
                        neuralObj.data['^confidence'] = maxScore;
                        neuralObj.data['^action'] = actionResult;
                        neuralObj.data['last'] = winningLabel;
                        neuralObj.data['confidence'] = maxScore;
                        neuralObj.data['action'] = actionResult;
                        
                        this.pushValue(neuralObj);
                        break;
                    }
                    case OPS.BUILD_BRAIN: {
                        // 1. Pop the 14 arguments exactly in reverse order of Compilation
                        const promptExpr = this.popValue();
                        const callbackFn = this.popValue();
                        const streamState = this.popValue();
                        const memoryState = this.popValue();
                        const identityStr = this.popValue();
                        const sampleMap  = this.popValue();
                        const stopPattern = this.popValue();
                        const limit      = this.popValue();
                        const exitSize   = this.popValue();
                        const entrySize  = this.popValue();
                        const topology   = this.popValue();
                        const legend     = this.popValue();
                        const configMap  = this.popValue();
                        const uses       = this.popValue();

                        let isCloud = false;
                        let endpoint = "";

                        // 2. Parse 'uses' to route the engine
                        if (Array.isArray(uses)) {
                            for (const u of uses) {
                                if (u.path && (u.path.startsWith("http://") || u.path.startsWith("https://"))) {
                                    isCloud = true;
                                    endpoint = u.path;
                                    break;
                                }
                            }
                        }

                        if (isCloud) {
                            const provider = this.getMapValue(configMap, "provider") || "unknown";
                            const model = this.getMapValue(configMap, "model") || "unknown";
                            if (this.logger) this.logger(`<span style="color:#0f0">[VM: BRAIN] Routing to Cloud (${provider}: ${model})</span>`);
                            throw this.makeBrainUnavailableError("cloud", {
                                summary: `${provider}:${model} -> ${endpoint}`
                            });
                        } else {
                            if (this.logger) this.logger(`<span style="color:#0f0">[VM: BRAIN] Routing to Local Tensor Engine</span>`);
                            if (configMap != null) {
                                throw this.makeDKError("Local brain does not support config maps", {
                                    type: "BrainError",
                                    code: "BRAIN_UNSUPPORTED_CONFIG",
                                    location: "brain:local"
                                });
                            }
                            if (!streamState && callbackFn != null) {
                                throw this.makeDKError("Local brain callback requires stream true", {
                                    type: "BrainError",
                                    code: "BRAIN_INVALID_CALLBACK",
                                    location: "brain:local"
                                });
                            }

                            const maxTokens = Number(limit);
                            if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
                                throw this.makeDKError("Local brain requires a positive limit", {
                                    type: "BrainError",
                                    code: "BRAIN_INVALID_LIMIT",
                                    location: "brain:local"
                                });
                            }

                            const promptText = String(promptExpr ?? "");
                            const { model, resources } = await this.loadLocalBrainBackend(uses);
                            const rawTopologyInfo = this.summarizeBrainTopology(topology, legend, entrySize, exitSize);
                            const topologyInfo = this.validateLocalBrainTopology(model, rawTopologyInfo, legend, entrySize, exitSize);
                            const sessionKey = this.getBrainSessionKey(resources, topologyInfo, identityStr, maxTokens, sampleMap);
                            const session = this.brainMemory.get(sessionKey) || { history: [] };
                            const contextParts = [];
                            if (identityStr != null) contextParts.push(String(identityStr));
                            if (memoryState && Array.isArray(session.history) && session.history.length > 0) {
                                contextParts.push(session.history.join(" "));
                            }
                            contextParts.push(promptText);
                            const fullPrompt = contextParts.filter(Boolean).join(" ").trim();

                            let finalOutput = "";
                            let tokensUsed = 0;
                            let scored = null;
                            const sampleConfig = this.getBrainSampleConfig(sampleMap);
                            if (callbackFn != null && !(callbackFn instanceof __dk_window.NativeFunction) && !(callbackFn instanceof __dk_window.ObjClosure)) {
                                throw this.makeDKError("Local brain callback must be a DK function", {
                                    type: "BrainError",
                                    code: "BRAIN_INVALID_CALLBACK",
                                    location: "brain:local"
                                });
                            }

                            if (!model.executable) {
                                const code = model.sourceFormat === "gguf"
                                    ? "BRAIN_GGUF_EXECUTION_UNAVAILABLE"
                                    : "BRAIN_LOCAL_UNAVAILABLE";
                                throw this.makeDKError("Local brain model metadata loaded, but executable inference is not implemented for this backend", {
                                    type: "BrainError",
                                    code,
                                    location: "brain:local"
                                });
                            }

                            if (model.runtimeKind === "classifier") {
                                if (sampleMap != null) {
                                    throw this.makeDKError("Local brain classifier backend does not support sample maps", {
                                        type: "BrainError",
                                        code: "BRAIN_UNSUPPORTED_SAMPLE",
                                        location: "brain:local"
                                    });
                                }
                                scored = this.scoreLocalBrainModel(model, promptText, {
                                    memoryState: !!memoryState,
                                    identityText: identityStr ? String(identityStr) : "",
                                    session
                                });
                                finalOutput = this.trimBrainOutput(scored.text, maxTokens);
                                finalOutput = this.applyBrainStop(finalOutput, stopPattern);
                                finalOutput = this.trimBrainOutput(finalOutput, maxTokens);
                                tokensUsed = this.tokenizeBrainText(finalOutput).length;
                            } else if (model.runtimeKind === "autoregressive") {
                                const chunks = [];
                                const emitChunk = streamState ? async (chunk) => {
                                    chunks.push(chunk);
                                    if (callbackFn != null) {
                                        try {
                                            await this.executeClosure(callbackFn, [chunk]);
                                        } catch (e) {
                                            throw this.coerceDKError(e, {
                                                type: "BrainError",
                                                code: "BRAIN_CALLBACK_ERROR",
                                                location: "brain:local"
                                            });
                                        }
                                    }
                                } : null;
                                scored = await this.generateLocalBrainText(model, fullPrompt, {
                                    maxTokens,
                                    stopPattern,
                                    sampleConfig,
                                    emitChunk
                                });
                                scored.chunks = chunks;
                                finalOutput = this.trimBrainOutput(scored.text, maxTokens);
                                tokensUsed = Number(scored.tokens || this.tokenizeBrainText(finalOutput).length);
                            } else {
                                const code = model.sourceFormat === "gguf"
                                    ? "BRAIN_GGUF_EXECUTION_UNAVAILABLE"
                                    : "BRAIN_LOCAL_UNAVAILABLE";
                                throw this.makeDKError("Local brain model metadata loaded, but executable inference is not implemented for this backend", {
                                    type: "BrainError",
                                    code,
                                    location: "brain:local"
                                });
                            }

                            const outputTokens = this.tokenizeBrainText(finalOutput);
                            const chunks = model.runtimeKind === "autoregressive"
                                ? (Array.isArray(scored?.chunks) ? scored.chunks : [])
                                : [];

                            if (streamState && model.runtimeKind !== "autoregressive") {
                                for (let i = 0; i < outputTokens.length; i++) {
                                    const chunk = this.makeBrainChunk(outputTokens[i], i + 1, i === outputTokens.length - 1);
                                    chunks.push(chunk);
                                    if (callbackFn != null) {
                                        try {
                                            await this.executeClosure(callbackFn, [chunk]);
                                        } catch (e) {
                                            throw this.coerceDKError(e, {
                                                type: "BrainError",
                                                code: "BRAIN_CALLBACK_ERROR",
                                                location: "brain:local"
                                            });
                                        }
                                    }
                                }
                            }

                            if (memoryState) {
                                const nextHistory = Array.isArray(session.history) ? session.history.slice() : [];
                                nextHistory.push(promptText);
                                if (finalOutput) nextHistory.push(finalOutput);
                                while (nextHistory.length > 8) nextHistory.shift();
                                this.brainMemory.set(sessionKey, { history: nextHistory });
                            }

                            const resultObj = { type: 'arr', data: [null], _base: 1 };
                            resultObj.data['^text'] = finalOutput;
                            resultObj.data['^confidence'] = scored.confidence;
                            resultObj.data['^tokens'] = tokensUsed;
                            resultObj.data['^mode'] = "local";
                            resultObj.data['^status'] = "ok";
                            resultObj.data['^reason'] = scored.reason;
                            resultObj.data['^label'] = scored.label || "generated";
                            resultObj.data['^memory'] = !!memoryState;
                            resultObj.data['^stream'] = !!streamState;
                            resultObj.data['^chunks'] = this.toDKArray(chunks, 1);

                            resultObj.data['text'] = finalOutput;
                            resultObj.data['confidence'] = scored.confidence;
                            resultObj.data['tokens'] = tokensUsed;
                            resultObj.data['mode'] = "local";
                            resultObj.data['status'] = "ok";
                            resultObj.data['reason'] = scored.reason;
                            resultObj.data['label'] = scored.label || "generated";
                            resultObj.data['memory'] = !!memoryState;
                            resultObj.data['stream'] = !!streamState;
                            resultObj.data['chunks'] = this.toDKArray(chunks, 1);

                            this.makeBrainResultHelpers(resultObj, model);

                            this.pushValue(resultObj);
                            break;
                        }
                    }
                    case OPS.BUILD_SOLVER: {
                        const timeoutVal = this.popValue();
                        const limitVal = this.popValue();
                        const modeVal = this.popValue();
                        const optimizeDefs = this.popValue();
                        const preferDefs = this.popValue();
                        const ruleDefs = this.popValue();
                        const domainNames = this.popValue();
                        const domainMap = this.popValue();

                        const names = Array.isArray(domainNames) ? domainNames.map(String) : [];
                        const domainChoices = this.getSolverDomainChoices(domainMap, names);
                        const ruleClosures = this.flattenSolverClosures(ruleDefs);
                        const preferClosures = this.flattenSolverClosures(preferDefs);
                        const optimizeItems = this.toJSArrayLike(optimizeDefs);
                        const mode = String(modeVal ?? "first").toLowerCase() === "all" ? "all" : "first";
                        const limit = Number(limitVal);
                        const comboLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100000;
                        const timeout = timeoutVal == null ? null : Number(timeoutVal);
                        const deadline = Number.isFinite(timeout) && timeout >= 0 ? Date.now() + timeout : null;
                        const shouldSearchAll = mode === "all" || preferClosures.length > 0 || optimizeItems.length > 0;

                        let tested = 0;
                        let pruned = 0;
                        let count = 0;
                        let complete = true;
                        let reason = "solved";
                        let bestSolution = null;
                        let bestScore = null;
                        const rankedSolutions = [];

                        if (names.length === 0) {
                            throw this.makeDKError("Solver requires at least one domain variable", {
                                type: "SolverError",
                                code: "SOLVER_DOMAIN_ERROR",
                                location: "solver.domain"
                            });
                        }

                        for (let i = 0; i < ruleClosures.length; i++) {
                            if (!this.isSolverCallable(ruleClosures[i])) {
                                throw this.makeDKError(`Solver rule ${i + 1} is not callable`, {
                                    type: "SolverError",
                                    code: "SOLVER_RULE_ERROR",
                                    location: `solver.rules.${i + 1}`
                                });
                            }
                        }

                        for (let i = 0; i < preferClosures.length; i++) {
                            if (!this.isSolverCallable(preferClosures[i])) {
                                throw this.makeDKError(`Solver prefer clause ${i + 1} is not callable`, {
                                    type: "SolverError",
                                    code: "SOLVER_PREFER_ERROR",
                                    location: `solver.prefer.${i + 1}`
                                });
                            }
                        }

                        for (let i = 0; i < optimizeItems.length; i++) {
                            const item = optimizeItems[i];
                            const kind = String(this.getArrayValue(item, 1) ?? "bool").toLowerCase();
                            const closure = this.getArrayValue(item, 2);
                            if (!["bool", "min", "max"].includes(kind)) {
                                throw this.makeDKError(`Solver optimize clause ${i + 1} has invalid kind '${kind}'`, {
                                    type: "SolverError",
                                    code: "SOLVER_OPTIMIZE_ERROR",
                                    location: `solver.optimize.${i + 1}`
                                });
                            }
                            if (!this.isSolverCallable(closure)) {
                                throw this.makeDKError(`Solver optimize clause ${i + 1} is not callable`, {
                                    type: "SolverError",
                                    code: "SOLVER_OPTIMIZE_ERROR",
                                    location: `solver.optimize.${i + 1}`
                                });
                            }
                        }

                        const scoreToObject = (score) => {
                            if (!score) return null;
                            return {
                                hard: score.hard || 0,
                                soft: score.soft || 0,
                                objectives: Array.isArray(score.objectives) ? score.objectives.slice() : []
                            };
                        };

                        const maybeStop = () => {
                            if (deadline !== null && Date.now() >= deadline) {
                                complete = false;
                                reason = "timeout";
                                return true;
                            }
                            if (tested >= comboLimit) {
                                complete = false;
                                reason = "limit";
                                return true;
                            }
                            return false;
                        };

                        const visitLeaf = async (assignments, args) => {
                            if (maybeStop()) return true;
                            tested += 1;

                            for (const closure of ruleClosures) {
                                const passed = await this.executeClosure(closure, args);
                                if (!passed) {
                                    pruned += 1;
                                    return false;
                                }
                            }

                            let soft = 0;
                            for (const closure of preferClosures) {
                                if (await this.executeClosure(closure, args)) soft += 1;
                            }

                            const objectives = [];
                            for (const item of optimizeItems) {
                                const kind = String(this.getArrayValue(item, 1) ?? "bool").toLowerCase();
                                const closure = this.getArrayValue(item, 2);
                                const value = await this.executeClosure(closure, args);
                                if (kind === "bool") {
                                    if (value) soft += 1;
                                } else {
                                    const num = Number(value);
                                    objectives.push(kind === "min" ? -num : num);
                                }
                            }

                            const solution = this.makeSolverSolution(assignments);
                            const score = { hard: ruleClosures.length, soft, objectives };
                            count += 1;

                            if (this.compareSolverScores(score, bestScore) > 0 || bestSolution == null) {
                                bestSolution = solution;
                                bestScore = score;
                            }

                            if (mode === "all") {
                                rankedSolutions.push({ solution, score, order: rankedSolutions.length });
                            }

                            return !shouldSearchAll;
                        };

                        const search = async (idx, assignments, args) => {
                            if (maybeStop()) return true;
                            if (idx >= names.length) {
                                return await visitLeaf(assignments, args);
                            }

                            const name = names[idx];
                            const choices = domainChoices[idx] || [];
                            for (const choice of choices) {
                                assignments[name] = choice;
                                args[idx] = choice;
                                const shouldStop = await search(idx + 1, assignments, args);
                                if (shouldStop) return true;
                                if (!complete && (reason === "limit" || reason === "timeout")) return true;
                            }
                            delete assignments[name];
                            return false;
                        };

                        if (names.length > 0) {
                            await search(0, {}, new Array(names.length).fill(null));
                        }

                        if (mode === "all") {
                            rankedSolutions.sort((a, b) => {
                                const cmp = this.compareSolverScores(b.score, a.score);
                                if (cmp !== 0) return cmp;
                                return a.order - b.order;
                            });
                        }

                        if (count === 0 && reason === "solved") {
                            reason = "unsat";
                        }

                        const resultObj = this.makeSolverResult({
                            ok: count > 0,
                            best: bestSolution,
                            score: scoreToObject(bestScore),
                            count,
                            complete,
                            mode,
                            solutions: mode === "all" ? rankedSolutions.map(x => x.solution) : null,
                            tested,
                            pruned,
                            reason
                        });

                        this.pushValue(resultObj);
                        break;
                    }

                    case OPS.TRY_BEGIN: {
                        const offset = (code[ip] << 8) | code[ip + 1];
                        ip += 2;
                        this.tryStack.push({ catchIp: ip + offset, sp: this.sp, bp: this.bp, frameCount: this.frameCount });
                        this.assertRuntimeState("TRY_BEGIN", frame);
                        break;
                    }
                    case OPS.TRY_END: {
                        this.tryStack.pop();
                        this.assertRuntimeState("TRY_END", frame);
                        break;
                    }
                    case OPS.THROW: { const err = this.stack[--this.sp]; throw err; }
                    case OPS.EXPLORE_FUNCTION_REF: {
                        const target = this.popValue();
                        let result = null;

                        if (target instanceof __dk_window.ObjClosure || target instanceof __dk_window.ObjFunction) {
                            const closure = target instanceof __dk_window.ObjClosure ? target : null;
                            const fn = closure ? closure.function : target;
                            result = this.toDKFlagValue({
                                type: "function",
                                name: fn.name || "anonymous",
                                arity: fn.arity || 0,
                                upvalueCount: fn.upvalueCount || 0,
                                bytecodeLength: fn.code ? fn.code.length : 0,
                                constants: fn.constants || [],
                                codeLines: fn.codeLines || [],
                                value: closure && closure.lastResult !== undefined ? closure.lastResult : null
                            });
                        } else {
                            result = this.toDKFlagValue({
                                type: typeof target,
                                value: target
                            });
                        }

                        this.pushValue(result);
                        break;
                    }
                }

                if (this.clearOnPop && this.sp < spBefore) {
                    for (let i = this.sp; i < spBefore; i++) this.stack[i] = null;
                }

                if (this.debug && this.sp > this.stackSize) {
                    throw new Error(`Stack overflow after ${this.lastOpName} @ ${opIp} (sp=${this.sp}, size=${this.stackSize})`);
                }

                if (this.sp < 0) {
                    throw new Error(`Stack underflow after ${this.lastOpName} @ ${opIp} (sp=${this.sp})`);
                }
                if (this.bp < -1) {
                    throw new Error(`Base pointer underflow after ${this.lastOpName} @ ${opIp} (bp=${this.bp})`);
                }
                if (this.frameCount > 0 && this.sp < this.bp) {
                    throw new Error(`Stack below base pointer after ${this.lastOpName} @ ${opIp} (sp=${this.sp}, bp=${this.bp})`);
                }
                this.assertRuntimeState(`post-op:${this.lastOpName}@${opIp}`, frame);
if (this.traceExecution) {
                this.opTrace.push({
                    idx: this.opTrace.length,
                    ip: opIp,
                    opName: this.lastOpName,
                    opCode: op,
                    preSp: spBefore,
                    postSp: this.sp,
                    preBp: bpBefore,
                    postBp: this.bp,
                    func: frame?.closure?.function?.name || "<anon>",
                    frameCount: this.frameCount
                });
                if (this.opTrace.length > this.opTraceMax) {
                    this.opTrace.shift();
                    for (let i = 0; i < this.opTrace.length; i++) this.opTrace[i].idx = i;
                }
            }
            } catch (e) {
                let crashLine = "Unknown";
                if (this.frameCount > 0) {
                    crashLine = frame.closure.function.codeLines[opIp] || "Unknown";
                }

                if (this.tryStack.length > 0) {
                    const handler = this.tryStack.pop();

                    this.closeUpvaluesAtOrAbove(handler.sp);
                    this.frameCount = handler.frameCount;
                    this.frames.length = this.frameCount;
                    this.sp = handler.sp;
                    this.bp = handler.bp;
                    this.pruneDeadLoopState(this.frameCount);
                    this.pruneDeadTryState(this.frameCount);
                    
                    if (this.frameCount > 0) {
                        frame = this.frames[this.frameCount - 1];
                        code = frame.closure.function.code;
                        constants = frame.closure.function.constants;
                    }
                    
                    // FIX: Force the loop to resume at the catch block
                    this.ip = handler.catchIp;
                    ip = handler.catchIp; 
                    if (frame) frame.ip = ip;

                   let errorObj = this.coerceDKError(e, { line: crashLine });
                    
                    this.pushValue(errorObj);
                    this.assertRuntimeState(`catch-resume:${this.lastOpName}@${opIp}`, frame);
                    continue;
                }

                const unwindFloor =
                    targetFrameCount > 0 && this.frames[targetFrameCount - 1]
                        ? this.frames[targetFrameCount - 1].bp + 1
                        : 0;
                this.closeUpvaluesAtOrAbove(unwindFloor);
                this.frameCount = targetFrameCount;
                if (this.frameCount > 0) {
                    this.frames.length = this.frameCount;
                    frame = this.frames[this.frameCount - 1];
                    this.bp = frame.bp;
                } else {
                    this.frames.length = 0;
                    frame = null;
                    this.bp = 0;
                }
                if (targetSp !== null) this.sp = targetSp;
                this.pruneDeadLoopState(this.frameCount);
                this.pruneDeadTryState(this.frameCount);
                
                const isDKVisibleError = !!(e && typeof e === "object" && e.type === "arr" && e.data);
                if (this.debug || !isDKVisibleError) {
                    this.dumpStack(this.describeError(e), false);
                }
                if (e instanceof Error && !e.message.includes("Line:")) {
                    e.message = `${e.message} at Line: ${crashLine}`;
                }
                throw e; 
            }
        }
    }
}

if (typeof __dk_window !== 'undefined') {
    __dk_window.VM = VM;
}
if (typeof module !== 'undefined') {
    module.exports = VM;
}
