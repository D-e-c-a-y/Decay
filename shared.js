/**
 * FOUNDATION: Shared Symbols with Full Call Logging
 */
if (!window.SymbolTable) {
    window.SymbolTable = new Map();
}

// Initialize DK array registry early to avoid temporal-dead-zone issues.
window.__DK_ARRAY_META = window.__DK_ARRAY_META || new WeakMap();
var DK_ARRAY_META = window.__DK_ARRAY_META;

window.intern = function(str) {
    if (str === null || str === undefined) return null;
    if (typeof str !== 'string') return str;
    
    // Only intern highly reused keywords/sigils, skip random user strings
    if (str.length < 32 && /^[a-zA-Z0-9_\^\*\#]+$/.test(str)) {
        if (!window.SymbolTable.has(str)) window.SymbolTable.set(str, str);
        return window.SymbolTable.get(str);
    }
    return str; 
};

// Export globals for modules to use without colliding with runtime script globals
var DKIntern = window.intern;
var DKSymbolTable = window.SymbolTable;
var DKLexer = window.Lexer;
var DKParser = window.Parser;
var DKCompiler = window.Compiler;
var DKVM = window.VM;
var DKMinifier = window.Minifier;
var DKCanonicalMinifier = window.DKMin;


/**
 * MOCK FILESYSTEM (Updated with std/math for imports)
 */
/*const MOCK_FS = {
        "std/math": `
            pi = 3.14159
            add = fn(a, b) @ a + b 
        #
        @ [pi: pi, add: add]
        `
    };
if (typeof globalThis !== "undefined") {
    globalThis.MOCK_FS = MOCK_FS;
}*/

function __dk_mock_gguf_string_bytes(str) {
    return Array.from(new TextEncoder().encode(String(str)));
}

function __dk_mock_gguf_make(options = {}) {
    const bytes = [];
    const pushU8 = (v) => bytes.push(v & 255);
    const pushU32 = (v) => {
        const n = Number(v >>> 0);
        pushU8(n & 255); pushU8((n >>> 8) & 255); pushU8((n >>> 16) & 255); pushU8((n >>> 24) & 255);
    };
    const pushU64 = (v) => {
        let n = BigInt(v);
        for (let i = 0; i < 8; i++) {
            pushU8(Number(n & 255n));
            n >>= 8n;
        }
    };
    const pushF32 = (v) => {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setFloat32(0, Number(v), true);
        bytes.push(...new Uint8Array(buf));
    };
    const pushString = (s) => {
        const data = __dk_mock_gguf_string_bytes(s);
        pushU64(data.length);
        bytes.push(...data);
    };
    const pushTensorData = (typeId, data) => {
        if (Number(typeId) === 0) {
            const arr = Array.isArray(data) || ArrayBuffer.isView(data) ? data : [];
            for (const value of arr) pushF32(value);
            return;
        }
        const arr = Array.isArray(data) || ArrayBuffer.isView(data) ? data : [];
        for (let i = 0; i < arr.length; i++) pushU8(0);
    };
    const pushValue = (type, value) => {
        pushU32(type);
        if (type === 4) pushU32(value);
        else if (type === 6) pushF32(value);
        else if (type === 8) pushString(value);
        else if (type === 9) {
            const arr = Array.isArray(value) ? value : [];
            const elemType = Number(options.arrayType || 8);
            pushU32(elemType);
            pushU64(arr.length);
            for (const item of arr) {
                if (elemType === 8) pushString(item);
                else if (elemType === 4) pushU32(item);
            }
        }
    };
    const alignment = Number(options.alignment || 32);
    const metadata = [
        ["general.architecture", 8, options.arch || "llama"],
        ["general.name", 8, options.name || "DK Mock GGUF"],
        ["general.alignment", 4, alignment],
        ["llama.block_count", 4, options.blockCount || 12],
        ["llama.attention.head_count", 4, options.headCount || 8],
        ["llama.embedding_length", 4, options.width || 512],
        ["llama.vocab_size", 4, options.vocabSize || 32000]
    ];
    if (Array.isArray(options.metadataExtra)) metadata.push(...options.metadataExtra);

    const tensorSpecs = Array.isArray(options.tensors) && options.tensors.length > 0
        ? options.tensors.map((tensor) => ({
            name: String(tensor.name || "tensor"),
            dims: Array.isArray(tensor.dims) ? tensor.dims.map(v => Number(v) || 0) : [4, 4],
            typeId: Number(tensor.typeId == null ? 0 : tensor.typeId),
            data: tensor.data || []
        }))
        : [{
            name: options.tensorName || "blk.0.attn_q.weight",
            dims: [4, 4],
            typeId: Number(options.tensorTypeId == null ? 0 : options.tensorTypeId),
            data: new Array(16).fill(0)
        }];

    const tensorOffsets = [];
    let runningOffset = 0;
    for (const tensor of tensorSpecs) {
        tensorOffsets.push(runningOffset);
        const itemCount = tensor.dims.reduce((acc, dim) => acc * Math.max(1, Number(dim) || 1), 1);
        runningOffset += Number(tensor.typeId) === 0 ? (itemCount * 4) : itemCount;
    }

    pushU8(71); pushU8(71); pushU8(85); pushU8(70); // GGUF
    pushU32(3);
    pushU64(tensorSpecs.length);
    pushU64(metadata.length);
    for (const [key, type, value] of metadata) {
        pushString(key);
        pushValue(type, value);
    }

    for (let i = 0; i < tensorSpecs.length; i++) {
        const tensor = tensorSpecs[i];
        pushString(tensor.name);
        pushU32(tensor.dims.length);
        for (const dim of tensor.dims) pushU64(dim);
        pushU32(tensor.typeId);
        pushU64(tensorOffsets[i]);
    }

    while (bytes.length % alignment !== 0) pushU8(0);
    for (const tensor of tensorSpecs) pushTensorData(tensor.typeId, tensor.data);
    return new Uint8Array(bytes);
}

function __dk_mock_brain_lm_definition() {
    const tokens = [
        "security", "risk", "detected", "inspect", "packet", "now",
        "system", "status", "nominal", "continue", "monitoring",
        "threat", "alert", "<eos>"
    ];
    const width = 8;
    const heads = 2;
    const layers = 2;
    const headWidth = width / heads;
    const tokenIndex = new Map(tokens.map((token, index) => [token, index]));

    const makeMatrix = (rows, cols, fill = 0) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill));
    const makeHeadWeights = () => Array.from({ length: heads }, (_, h) =>
        Array.from({ length: headWidth }, (_, r) =>
            Array.from({ length: headWidth }, (_, c) => (r === c ? 1 : 0))
        )
    );

    const encoderIn = makeMatrix(tokens.length, width, 0);
    const addFeature = (token, slot, value) => { encoderIn[tokenIndex.get(token)][slot] += value; };
    addFeature("security", 0, 3);
    addFeature("risk", 0, 1);
    addFeature("detected", 0, 1);
    addFeature("inspect", 0, 1);
    addFeature("packet", 0, 2);
    addFeature("threat", 0, 4);
    addFeature("alert", 0, 3);
    addFeature("system", 1, 4);
    addFeature("status", 1, 3);
    addFeature("nominal", 1, 1);
    addFeature("continue", 1, 2);
    addFeature("monitoring", 1, 1);

    const startHead = makeMatrix(width, tokens.length, 0);
    startHead[0][tokenIndex.get("security")] = 4;
    startHead[1][tokenIndex.get("system")] = 4;
    startHead[1][tokenIndex.get("status")] = 2;
    startHead[0][tokenIndex.get("inspect")] = 1;

    const ctxHead = makeMatrix(width, tokens.length, 0);
    ctxHead[0][tokenIndex.get("security")] = 0.3;
    ctxHead[1][tokenIndex.get("system")] = 0.3;
    ctxHead[1][tokenIndex.get("status")] = 0.2;

    const transition = makeMatrix(tokens.length, tokens.length, -2);
    const chain = (from, to, score = 8) => { transition[tokenIndex.get(from)][tokenIndex.get(to)] = score; };
    chain("security", "risk");
    chain("risk", "detected");
    chain("detected", "inspect");
    chain("inspect", "packet");
    chain("packet", "now");
    chain("now", "<eos>");
    chain("system", "status");
    chain("status", "nominal");
    chain("nominal", "continue");
    chain("continue", "monitoring");
    chain("monitoring", "<eos>");
    transition[tokenIndex.get("<eos>")][tokenIndex.get("<eos>")] = 8;

    const outputBias = Array.from({ length: tokens.length }, () => -0.5);
    outputBias[tokenIndex.get("<eos>")] = -1.5;

    const mixers = Array.from({ length: layers }, () => ({
        head_weights: makeHeadWeights(),
        bias: Array.from({ length: width }, () => 0)
    }));

    return {
        tokens,
        width,
        heads,
        layers,
        headWidth,
        encoderIn,
        startHead,
        ctxHead,
        transition,
        outputBias,
        mixers
    };
}

function __dk_mock_brain_lm_json() {
    const spec = __dk_mock_brain_lm_definition();
    return JSON.stringify({
        kind: "dk-brain-lm",
        version: 1,
        topology: {
            legend: ["l", "h", "w"],
            entry: spec.tokens.length,
            exit: spec.tokens.length,
            rows: [
                { l: spec.layers, h: spec.heads, w: spec.width }
            ]
        },
        tokens: spec.tokens,
        backend: {
            eos_token: "<eos>",
            encoder_in: spec.encoderIn,
            mixers: spec.mixers,
            start_head: spec.startHead,
            ctx_head: spec.ctxHead,
            transition: spec.transition,
            output_bias: spec.outputBias
        }
    });
}

function __dk_mock_brain_lm_gguf() {
    const spec = __dk_mock_brain_lm_definition();
    const flatten2 = (matrix) => matrix.flat();
    const flatten3 = (tensor) => tensor.flat(2);
    return __dk_mock_gguf_make({
        arch: "dk",
        name: "DK Tiny Brain LM",
        blockCount: spec.layers,
        headCount: spec.heads,
        width: spec.width,
        vocabSize: spec.tokens.length,
        metadataExtra: [
            ["tokenizer.ggml.tokens", 9, spec.tokens],
            ["tokenizer.ggml.vocab_size", 4, spec.tokens.length],
            ["dk.brain.kind", 8, "autoregressive"],
            ["dk.brain.eos_token", 8, "<eos>"],
            ["dk.topology.block_count", 4, spec.layers],
            ["dk.topology.head_count", 4, spec.heads],
            ["dk.topology.width", 4, spec.width],
            ["dk.topology.entry", 4, spec.tokens.length],
            ["dk.topology.exit", 4, spec.tokens.length]
        ],
        tensors: [
            { name: "dk.encoder_in", dims: [spec.tokens.length, spec.width], typeId: 0, data: flatten2(spec.encoderIn) },
            { name: "dk.start_head", dims: [spec.width, spec.tokens.length], typeId: 0, data: flatten2(spec.startHead) },
            { name: "dk.ctx_head", dims: [spec.width, spec.tokens.length], typeId: 0, data: flatten2(spec.ctxHead) },
            { name: "dk.transition", dims: [spec.tokens.length, spec.tokens.length], typeId: 0, data: flatten2(spec.transition) },
            { name: "dk.output_bias", dims: [spec.tokens.length], typeId: 0, data: spec.outputBias },
            { name: "dk.mixer.0.head_weights", dims: [spec.heads, spec.headWidth, spec.headWidth], typeId: 0, data: flatten3(spec.mixers[0].head_weights) },
            { name: "dk.mixer.0.bias", dims: [spec.width], typeId: 0, data: spec.mixers[0].bias },
            { name: "dk.mixer.1.head_weights", dims: [spec.heads, spec.headWidth, spec.headWidth], typeId: 0, data: flatten3(spec.mixers[1].head_weights) },
            { name: "dk.mixer.1.bias", dims: [spec.width], typeId: 0, data: spec.mixers[1].bias }
        ]
    });
}

function __dk_mock_brain_sampling_definition() {
    const tokens = ["alpha", "beta", "gamma", "<eos>"];
    const width = 4;
    const heads = 1;
    const layers = 1;
    const headWidth = width / heads;

    const makeMatrix = (rows, cols, fill = 0) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill));
    const makeHeadWeights = () => Array.from({ length: heads }, () =>
        Array.from({ length: headWidth }, (_, r) =>
            Array.from({ length: headWidth }, (_, c) => (r === c ? 1 : 0))
        )
    );

    const startHead = makeMatrix(width, tokens.length, 0);
    startHead[0][0] = 1;
    startHead[0][1] = 1;
    startHead[0][2] = 1;

    const transition = makeMatrix(tokens.length, tokens.length, -3);
    transition[0][0] = 8;
    transition[0][1] = 7;
    transition[0][3] = 2;
    transition[1][1] = 8;
    transition[1][3] = 2;
    transition[2][2] = 8;
    transition[2][3] = 2;
    transition[3][3] = 8;

    return {
        tokens,
        width,
        heads,
        layers,
        headWidth,
        encoderIn: makeMatrix(tokens.length, width, 0),
        startHead,
        ctxHead: makeMatrix(width, tokens.length, 0),
        transition,
        outputBias: [0, 0, 0, -1],
        mixers: [
            {
                head_weights: makeHeadWeights(),
                bias: Array.from({ length: width }, () => 0)
            }
        ]
    };
}

function __dk_mock_brain_sampling_json() {
    const spec = __dk_mock_brain_sampling_definition();
    return JSON.stringify({
        kind: "dk-brain-lm",
        version: 1,
        topology: {
            legend: ["l", "h", "w"],
            entry: spec.tokens.length,
            exit: spec.tokens.length,
            rows: [
                { l: spec.layers, h: spec.heads, w: spec.width }
            ]
        },
        tokens: spec.tokens,
        backend: {
            eos_token: "<eos>",
            encoder_in: spec.encoderIn,
            mixers: spec.mixers,
            start_head: spec.startHead,
            ctx_head: spec.ctxHead,
            transition: spec.transition,
            output_bias: spec.outputBias
        }
    });
}

// Virtual Filesystem Data
    const MOCK_FS_DATA = {
        "test/std/math": `
            pi = 3.14159
            add = fn(a, b) @ a + b
            mathMethod = fn(p) @ p * 2
        `,
        "Animal": `
            ** Animal
                speak() @ "Woof!"
            **
        `,
        "testScript": `
            in()
                x = 10
                y = 20
                sum = x + y
            @
        `,
        "suite_module_capture_helper": `
            base = 30
            build(seed)
                step(n):
                    @ base + seed + n
                @ step
            @ [base: base, build: build]
        `,
        "models/test_brain_model.json": `{
            "kind": "dk-brain-model",
            "version": 1,
            "default_response": "Local model needs more signal",
            "default_label": "default",
            "topology": {
                "legend": ["l", "h", "w"],
                "entry": 32000,
                "exit": 32000,
                "rows": [
                    { "l": 12, "h": 8, "w": 512 },
                    { "l": 6, "h": 8, "w": 512 }
                ]
            },
            "classes": [
                {
                    "name": "security",
                    "response": "Security risk detected inspect packet now",
                    "bias": 0,
                    "weights": {
                        "packet": 2.5,
                        "threat": 3.5,
                        "alert": 2.0,
                        "inspect": 1.5,
                        "risk": 2.5
                    }
                },
                {
                    "name": "science",
                    "response": "Scientific summary stable evidence supports analysis",
                    "bias": 0,
                    "weights": {
                        "research": 3.0,
                        "study": 2.5,
                        "evidence": 2.5,
                        "analysis": 1.5,
                        "document": 1.0
                    }
                },
                {
                    "name": "status",
                    "response": "System status nominal continue monitoring",
                    "bias": 0.5,
                    "weights": {
                        "status": 2.0,
                        "system": 2.0,
                        "monitor": 1.5,
                        "nominal": 1.0
                    }
                }
            ]
        }`,
        "models/test_brain_vocab.json": `{
            "kind": "dk-brain-vocab",
            "version": 1,
            "tokens": [
                "packet", "threat", "alert", "inspect", "risk",
                "research", "study", "evidence", "analysis", "document",
                "status", "system", "monitor", "nominal"
            ]
        }`,
        "models/test_brain_lm_model.json": __dk_mock_brain_lm_json(),
        "models/test_brain_lm.gguf": __dk_mock_brain_lm_gguf(),
        "models/test_brain_lm.weights": __dk_mock_brain_lm_json(),
        "models/test_brain_lm.weightsbin": __dk_mock_brain_lm_gguf(),
        "models/test_brain_vocab.tokens": `{
            "kind": "dk-brain-vocab",
            "version": 1,
            "tokens": [
                "security", "risk", "detected", "inspect", "packet", "now",
                "system", "status", "nominal", "continue", "monitoring",
                "threat", "alert", "<eos>"
            ]
        }`,
        "models/test_brain_sampling_model.json": __dk_mock_brain_sampling_json(),
        "models/test_meta.gguf": __dk_mock_gguf_make({
            name: "DK Metadata GGUF",
            blockCount: 12,
            headCount: 8,
            width: 512,
            vocabSize: 32000,
            tensorTypeId: 0
        }),
        "models/test_bad_tensor.gguf": __dk_mock_gguf_make({
            name: "DK Bad Tensor GGUF",
            blockCount: 12,
            headCount: 8,
            width: 512,
            vocabSize: 32000,
            tensorTypeId: 255
        })
    };

// 2. Host filesystem for module loading
const HOST_MOCK_FS = {
    read: (path) => {
        let cleanPath = String(path || "").replace(/^(modules|src)\//, "");
        if (MOCK_FS_DATA[cleanPath]) return MOCK_FS_DATA[cleanPath];
        // Handle namespaced imports (e.g., 'std/math' vs 'math')
        if (MOCK_FS_DATA["std/" + cleanPath]) return MOCK_FS_DATA["std/" + cleanPath];
        throw new Error(`File not found: ${cleanPath}`);
    }
};

const HOST_BROWSER = {
    _dkpListeners: new Map(),
    _dkpChannels: new Map(),
    _nextDKPListenerId: 1,
    capabilities: new Map([
        ["fetch_text", async (url, options = {}) => {
            const response = await fetch(String(url), options && typeof options === "object" ? options : undefined);
            return await response.text();
        }],
        ["fetch_json", async (url, options = {}) => {
            const response = await fetch(String(url), options && typeof options === "object" ? options : undefined);
            return await response.json();
        }],
        ["storage_get", (key) => {
            try {
                if (typeof window.localStorage === "undefined") return null;
                const value = window.localStorage.getItem(String(key));
                if (value === null) return null;
                try { return JSON.parse(value); }
                catch (_) { return value; }
            } catch (_) {
                return null;
            }
        }],
        ["storage_set", (key, value) => {
            if (typeof window.localStorage === "undefined") return false;
            const payload = (value !== null && typeof value === "object") ? JSON.stringify(value) : String(value);
            window.localStorage.setItem(String(key), payload);
            return true;
        }],
        ["dom_set_text", ({ selector, text } = {}) => {
            if (typeof document === "undefined") return false;
            const target = document.querySelector(String(selector || ""));
            if (!target) return false;
            target.textContent = text == null ? "" : String(text);
            return true;
        }],
        ["read_line", async (promptMessage) => {
            await new Promise((resolve) => {
                const finish = () => setTimeout(resolve, 0);
                if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
                    window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
                    return;
                }
                finish();
            });
            if (typeof prompt === "undefined") return null;
            const value = prompt(String(promptMessage ?? ""));
            return value == null ? null : String(value);
        }]
    ]),
    loadModuleSource(specifier) {
        const target = String(specifier || "");
        return {
            path: target,
            source: HOST_MOCK_FS.read(target)
        };
    },
    hasCapability(name) {
        return this.capabilities.has(String(name || ""));
    },
    async callCapability(name, args = [], meta = {}) {
        const key = String(name || "");
        if (!this.capabilities.has(key)) {
            throw new Error(`Host capability '${key}' is not available`);
        }
        const fn = this.capabilities.get(key);
        const list = Array.isArray(args) ? args : [args];
        return await fn(...list, meta);
    },
    async readResource(specifier, options = {}) {
        const target = String(specifier || "");
        const raw = HOST_MOCK_FS.read(target);
        if (options.binary) {
            if (raw instanceof Uint8Array) return raw;
            return new TextEncoder().encode(String(raw));
        }
        if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
        return String(raw);
    },
    async sendDKPPulse(channel, packet) {
        const key = String(channel || "");
        const listeners = this._dkpChannels.get(key);
        if (!listeners || listeners.size === 0) return false;
        for (const listener of Array.from(listeners)) {
            await listener(packet, key);
        }
        return true;
    },
    listenDKPChannel(channel, listener) {
        const key = String(channel || "");
        const id = "dkp:" + (this._nextDKPListenerId++);
        if (!this._dkpChannels.has(key)) this._dkpChannels.set(key, new Set());
        this._dkpChannels.get(key).add(listener);
        this._dkpListeners.set(id, { channel: key, listener });
        return id;
    },
    unlistenDKPChannel(listenerId) {
        const id = String(listenerId || "");
        const entry = this._dkpListeners.get(id);
        if (!entry) return false;
        this._dkpListeners.delete(id);
        const listeners = this._dkpChannels.get(entry.channel);
        if (listeners) {
            listeners.delete(entry.listener);
            if (listeners.size === 0) this._dkpChannels.delete(entry.channel);
        }
        return true;
    }
};

let hostVM = null;
function getHostVM() {
    if (!hostVM) {
        hostVM = new DKVM(log);
        hostVM.MOCK_FS = HOST_MOCK_FS;
        hostVM.host = HOST_BROWSER;
        hostVM.Lexer = DKLexer;
        hostVM.Parser = DKParser;
        hostVM.Compiler = DKCompiler;
        hostVM.Minifier = DKMinifier;
    }
    return hostVM;
}

const ORIGINAL_FETCH = window.fetch;

function formatHostError(error) {
    if (error && typeof error === "object" && error.type === "arr" && error.data) {
        return String(error.data["^msg"] || error.data.msg || "[DK ERROR]");
    }
    if (error instanceof Error) return String(error.message || error);
    if (error && typeof error === "object") {
        try { return JSON.stringify(error); }
        catch (_) { return String(error); }
    }
    return String(error);
}
window.fetch = async (...args) => {
    const url = args[0].toString();
    // --- GLOBAL HELPERS ---
    
    const mockFiles = {
        // REQUIRED FOR TEST SUITE:
        //"std/math": `pi = 3.14159\nadd(a,b) @ a+b`,
        
        // Examples for potential future tests:
        "compiler/lexer.dk": `CLASS Lexer\n  in(code)\n    self.code = code\n    self.pos = 1\n  **\n**`,
        "compiler/parser.dk": `CLASS Parser\n  in(tokens)\n    self.tokens = tokens\n  **\n**`
    };

    for (let path in mockFiles) {
        if (url.endsWith(path)) {
            console.log(`[MOCK FS] Intercepted: ${path}`);
            return { ok: true, text: async () => mockFiles[path] };
        }
    }
    return ORIGINAL_FETCH(...args);
};


/**
 * UI HELPERS
 */
function log(msg) {
    const consoleElem = document.getElementById('console');
    if (!consoleElem) return;
    if (msg === "CLS") {
        consoleElem.replaceChildren();
        return;
    }

    const wrapper = document.createElement("div");
    wrapper.innerHTML = String(msg);
    consoleElem.appendChild(wrapper);
    consoleElem.scrollTop = consoleElem.scrollHeight;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}


/**
 * CONTROLLER: Main Execution Logic
 */
// In shared.js

async function runDK(codeOverride = null, options = {}) {
    let userCode = codeOverride || document.getElementById('code-input').value;
    if (!options || !options.preserveLog) {
        log("CLS");
    }

    try {
        // 1. Lex & Parse (instrumented to pinpoint stalls)
        log("Lexing...");
        const lexer = new DKLexer(userCode);
        const tokens = lexer.tokenize();
        log(`Lexed ${tokens.length} tokens.`);

        log("Parsing...");
        const parser = new DKParser(tokens, log);
        const ast = parser.parse();
        log(`Parsed ${ast.length} top-level nodes.`);

        // 2. COMPILE (The New Step)
        log("Compiling...");
        const compiler = new DKCompiler(log);
        const chunk = compiler.compile(ast);
        
        // Debug: Show the Bytecode
        console.log("Bytecode:", chunk.code);
        console.log("Constants:", chunk.constants);

        // 3. EXECUTE (The New Engine)
        log("Running VM...");
        const vm = new DKVM(log);
        if (typeof vm.setRuntimeFlags === "function") {
            vm.setRuntimeFlags(window.DK_FLAGS || {});
        }

        // Pass dependencies for module loading
        vm.MOCK_FS = HOST_MOCK_FS;
        vm.host = HOST_BROWSER;
        vm.Lexer = DKLexer;
        vm.Parser = DKParser;
        vm.Compiler = DKCompiler;
        vm.Minifier = DKMinifier;
        
        vm.traceExecution = false;
        await vm.interpret(chunk);
        
        log("<div class='success'>[ VM FINISHED ]</div>");
        return { ok: true };

    } catch (e) {
        log(`<div class='error'>${escapeHtml(formatHostError(e))}</div>`);
        console.error(e);
        return { ok: false, error: e };
    }
}


/**
 * SELF-HOSTED RUNNER
 * Loads DK.dk (DK-based compiler/VM) and runs editor code via DK entrypoint.
 */
async function runSelfHosted() {
    const editor = document.getElementById('code-input');
    const userCode = editor ? editor.value : "";
    if (!userCode) return;

    const DK_SCRIPT_PATHS = ["DK.dk", "src/DK.dk"];
    const DK_ENTRY = "run";

    log("CLS");
    log("Loading self-hosted runtime...");

    let dkSource = null;
    let dkPathUsed = null;
    try {
        const host = getHostVM();
        if (host && host.MOCK_FS && typeof host.MOCK_FS.read === "function") {
            for (const p of DK_SCRIPT_PATHS) {
                try {
                    dkSource = host.MOCK_FS.read(p);
                    if (dkSource) { dkPathUsed = p; break; }
                } catch (_) {}
            }
        }
    } catch (_) {
        dkSource = null;
    }

    if (!dkSource) {
        for (const p of DK_SCRIPT_PATHS) {
            try {
                const resp = await fetch(p);
                if (resp && resp.ok) {
                    dkSource = await resp.text();
                    dkPathUsed = p;
                    break;
                }
            } catch (e) {
                dkSource = null;
            }
        }
    }

    if (!dkSource) {
        log(`<div class='error'>Self-host script not found. Tried: ${DK_SCRIPT_PATHS.join(", ")}</div>`);
        log("<div class='error'>If you opened index.html as file://, fetch may be blocked. Run via a local server or add DK.dk to MOCK_FS_DATA.</div>");
        return;
    }

    try {
        // 1) Compile DK.dk using the JS host toolchain
        const lexer = new DKLexer(dkSource);
        const parser = new DKParser(lexer.tokenize(), log);
        const ast = parser.parse();
        const compiler = new DKCompiler(log);
        const chunk = compiler.compile(ast);

        // 2) Run DK.dk in a fresh VM
        const hostVM = new DKVM(log);
        if (typeof hostVM.setRuntimeFlags === "function") {
            hostVM.setRuntimeFlags(window.DK_FLAGS || {});
        }
        hostVM.MOCK_FS = HOST_MOCK_FS;
        hostVM.host = HOST_BROWSER;
        hostVM.Lexer = DKLexer;
        hostVM.Parser = DKParser;
        hostVM.Compiler = DKCompiler;
        hostVM.Minifier = DKMinifier;
        hostVM.traceExecution = false;
        await hostVM.interpret(chunk);

        // 3) Invoke DK entrypoint with editor code
        if (!hostVM.globals.has(DK_ENTRY)) {
            log(`<div class='error'>Self-host entry not found: ${DK_ENTRY}(code)</div>`);
            if (dkPathUsed) log(`<div class='error'>Loaded from: ${dkPathUsed}</div>`);
            return;
        }

        log("Running self-hosted VM...");
        const result = await hostVM.invokeGlobal(DK_ENTRY, [userCode]);
        if (result !== undefined && result !== null) {
            log(`<div class='success'>[ SELF-HOSTED RESULT ] ${hostVM.stringify(result)}</div>`);
        } else {
            log("<div class='success'>[ SELF-HOSTED FINISHED ]</div>");
        }
    } catch (e) {
        log(`<div class='error'>${escapeHtml(formatHostError(e))}</div>`);
        console.error(e);
    }
}

window.runDK = runDK;
// Expose self-hosted runner to the UI
window.runSelfHosted = runSelfHosted;


/**
 * MINIFIER CONTROLLER
 * Exposed to window so HTML buttons can click it
 */
async function runMinifierUI(MinifierClass, label) {
    const editor = document.getElementById('code-input');
    let userCode = editor ? editor.value : "";
    
    if (!userCode) return;

    try {
        if (typeof MinifierClass !== 'function') {
            throw new Error(`${label} is not available in this build`);
        }

        // 1. Minify
        const minifier = new MinifierClass(userCode);
        const minified = minifier.minify();
        
        // 2. Calculate Stats
        const originalSize = userCode.length;
        const minifiedSize = minified.length;
        const savings = ((1 - (minifiedSize / originalSize)) * 100).toFixed(1);
        
        // 3. Output Results
        const consoleDiv = document.getElementById('console');
        consoleDiv.innerHTML = ""; // Clear console for clean stats display
        
        log(`<div class='stats' style="color:#aaa; border-bottom:1px solid #333; padding-bottom:5px; margin-bottom:10px;">
            ${escapeHtml(label)} | Original: <b>${originalSize}b</b> | Minified: <b>${minifiedSize}b</b> | Savings: <b>${savings}%</b>
        </div>`);
        
        // Display the minified code in a copy-friendly block
        log(`<div class='dk-out' style="background:#111; padding:10px; font-family:monospace; word-break:break-all; color:#0f0; margin-bottom:15px;">${escapeHtml(minified)}</div>`);
        
        // 4. Auto-Run Verification
        log(`<b>Verifying ${escapeHtml(label)} output...</b>`);
        log("-----------------------------");

        // Reuse the main runner logic, passing the minified string directly
        const verify = await runDK(minified, { preserveLog: true });
        if (!verify || verify.ok !== true) {
            const err = verify && verify.error ? verify.error : new Error("Minified verification failed");
            throw err;
        }
        log(`<div class='success' style='margin-top:10px; border-top:1px solid #333; padding-top:5px;'>[ ${escapeHtml(label)} VERIFIED ]</div>`);
    } catch(e) {
        log(`<div class='error'>[${escapeHtml(label)} FAILED] ${escapeHtml(formatHostError(e))}</div>`);
    }
}

window.minifyDK = async function() {
    return runMinifierUI(DKMinifier, "MINIFY");
};

window.minifyDK2 = async function() {
    return runMinifierUI(DKCanonicalMinifier, "DKMin");
};

/**
 * Other helpers
 */
// shared.js

// Array registry for DK arrays (real JS arrays + metadata in WeakMap)

function dkArrayEnsure(arr) {
    // FIX: Accept both standard JS arrays and raw TypedArrays
    if (!Array.isArray(arr) && !ArrayBuffer.isView(arr)) return null; 
    let meta = DK_ARRAY_META.get(arr);
    if (!meta) {
        meta = { base: 1, hybridKeys: [] };
        DK_ARRAY_META.set(arr, meta);
    }
    if (!Array.isArray(meta.hybridKeys)) meta.hybridKeys = [];
    return meta;
}

function dkArrayCreate(items = [], base = 1) {
    const arr = Array.isArray(items) ? items.slice() : [];
    const meta = dkArrayEnsure(arr);
    const n = Number(base);
    meta.base = Number.isFinite(n) ? n : 1;
    return arr;
}

// HELPER: Create a Typed Memory Buffer (Now returns a RAW TypedArray)
function dkBufferCreate(size, type = 'f32') {
    const numElements = Number(size);
    const bytesPerElement = (type === 'f32' || type === 'i32') ? 4 : 1;
    const byteLength = numElements * bytesPerElement;

    const buffer = typeof SharedArrayBuffer !== 'undefined' 
        ? new SharedArrayBuffer(byteLength) 
        : new ArrayBuffer(byteLength);

    let dataView;
    if (type === 'f32') dataView = new Float32Array(buffer);
    else if (type === 'i32') dataView = new Int32Array(buffer);
    else dataView = new Uint8Array(buffer);

    // Register it in the WeakMap to support DK's 1-based indexing
    dkArrayEnsure(dataView); 
    
    return dataView; 
}

// Make sure to expose it to the global window object at the bottom of shared.js:
// window.dkBufferCreate = dkBufferCreate;

function dkArrayBaseGet(arr) {
    const meta = dkArrayEnsure(arr);
    return meta ? meta.base : 1;
}

function dkArrayBaseSet(arr, base) {
    const meta = dkArrayEnsure(arr);
    if (!meta) return;
    const n = Number(base);
    meta.base = Number.isFinite(n) ? n : 1;
}

// HELPER: Convert Raw JS -> DK Objects
// Handles the internal '^' prefix so VM can read the keys
function toDK(val) {
    if (val === null || val === undefined) return null;
    if (Array.isArray(val)) {
        return dkArrayCreate(val.map(toDK), 1);
    }
    if (typeof val === 'object') {
        const wrapper = { type: 'arr', data: [null], _base: 1, _isMap: true };
        for (const k in val) {
            // INTERNAL: Add '^' prefix so the VM can read this object later
            wrapper.data["^" + k] = toDK(val[k]);
        }
        return wrapper;
    }
    return val;
}

// HELPER: Convert DK Objects -> Raw JS (for JSON.stringify)
// Strips the internal '^' prefix so the output is clean JSON
function toJS(val) {
    if (val === null || val === undefined) return val;
    
    // Handle DK registered arrays
    if (Array.isArray(val)) {
        const props = {};
        let hasProps = false;
        for (const k of Object.keys(val)) {
            if (k.startsWith("^")) {
                props[k.substring(1)] = toJS(val[k]);
                hasProps = true;
            }
        }
        if (hasProps) return props;
        return val.map(toJS);
    }

    // Handle DK wrapper objects (maps/modules/errors)
    if (val && val.type === 'arr') {
        // 1. Grab array part
        const resultArr = val.data.slice(val._base || 1).map(toJS);
        
        // 2. Grab map part (Named Properties)
        const props = {};
        let hasProps = false;
        
        // Iterate raw data and STRIP the '^' prefix
        for (const k in val.data) {
            if (k.startsWith('^')) {
                const cleanKey = k.substring(1); // Remove internal prefix
                props[cleanKey] = toJS(val.data[k]);
                hasProps = true;
            }
        }
        
        // If it has map keys, treat as Object. Otherwise treat as Array.
        if (hasProps) return props;
        return resultArr;
    }
    return val;
}

// Node.js / Browser compatibility
if (typeof window !== 'undefined') {
    window.toDK = toDK;
    window.toJS = toJS;
    window.dkArrayEnsure = dkArrayEnsure;
    window.dkArrayCreate = dkArrayCreate;
    window.dkArrayBaseGet = dkArrayBaseGet;
    window.dkArrayBaseSet = dkArrayBaseSet;
    window.dkBufferCreate = dkBufferCreate;
}
if (typeof module !== 'undefined') {
    module.exports = {
        toDK,
        toJS,
        dkArrayEnsure,
        dkArrayCreate,
        dkArrayBaseGet,
        dkArrayBaseSet,
        dkBufferCreate
    };
}


console.log("[HEARTBEAT] shared.js loaded.");
