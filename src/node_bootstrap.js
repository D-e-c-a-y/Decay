const root = (() => {
    if (typeof globalThis !== "undefined") {
        if (!globalThis.window) globalThis.window = globalThis;
        return globalThis.window;
    }
    return {};
})();

if (!root.SymbolTable) {
    root.SymbolTable = new Map();
}
root.__DK_ARRAY_META = root.__DK_ARRAY_META || new WeakMap();
const DK_ARRAY_META = root.__DK_ARRAY_META;

function intern(str) {
    if (str === null || str === undefined) return null;
    if (typeof str !== "string") return str;
    if (str.length < 32 && /^[a-zA-Z0-9_\^\*\#]+$/.test(str)) {
        if (!root.SymbolTable.has(str)) root.SymbolTable.set(str, str);
        return root.SymbolTable.get(str);
    }
    return str;
}

function dkArrayEnsure(arr) {
    if (!Array.isArray(arr) && !ArrayBuffer.isView(arr)) return null;
    let meta = DK_ARRAY_META.get(arr);
    if (!meta) {
        meta = { base: 1 };
        DK_ARRAY_META.set(arr, meta);
    }
    return meta;
}

function dkArrayCreate(items = [], base = 1) {
    const arr = Array.isArray(items) ? items.slice() : [];
    const meta = dkArrayEnsure(arr);
    const n = Number(base);
    meta.base = Number.isFinite(n) ? n : 1;
    return arr;
}

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

function dkBufferCreate(size, type = "f32") {
    const n = Math.max(0, Number(size) || 0);
    if (type === "u8") return new Uint8Array(n);
    if (type === "i32") return new Int32Array(n);
    return new Float32Array(n);
}

function toDK(val) {
    if (val === null || val === undefined) return null;
    if (ArrayBuffer.isView(val)) return val;
    if (Array.isArray(val)) return dkArrayCreate(val.map(toDK), 1);
    if (typeof val === "object") {
        const wrapper = { type: "arr", data: [null], _base: 1 };
        for (const [k, v] of Object.entries(val)) {
            wrapper.data["^" + k] = toDK(v);
        }
        return wrapper;
    }
    return val;
}

function toJS(val) {
    if (val === null || val === undefined) return val;

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

    if (ArrayBuffer.isView(val)) {
        return Array.from(val);
    }

    if (val && val.type === "arr" && val.data) {
        const resultArr = val.data.slice(val._base || 1).map(toJS);
        const props = {};
        let hasProps = false;
        for (const k in val.data) {
            if (k.startsWith("^")) {
                const cleanKey = k.substring(1);
                props[cleanKey] = toJS(val.data[k]);
                hasProps = true;
            }
        }
        if (hasProps) return props;
        return resultArr;
    }
    return val;
}

Object.assign(root, {
    intern,
    dkArrayEnsure,
    dkArrayCreate,
    dkArrayBaseGet,
    dkArrayBaseSet,
    dkBufferCreate,
    toDK,
    toJS
});

const vmTypes = require("./vm_types");
Object.assign(root, vmTypes);

const Lexer = require("./lexer");
const Parser = require("./parser");
const Compiler = require("./compiler");
const Minifier = require("./minifier");
const DKMin = require("./dkmin");
const VM = require("./vm");

Object.assign(root, {
    Lexer,
    Parser,
    Compiler,
    Minifier,
    DKMin,
    VM
});

function formatDKError(error) {
    if (error && typeof error === "object" && error.type === "arr" && error.data) {
        return {
            type: String(error.data["^type"] || "Error"),
            code: error.data["^code"] ? String(error.data["^code"]) : null,
            message: String(error.data["^msg"] || "Unknown error")
        };
    }
    if (error instanceof Error) {
        const rawMsg = String(error.message || error);
        const phaseMatchers = [
            { prefix: "[LEXER ERROR]", type: "LexerError", code: "LEXER_ERROR" },
            { prefix: "[PARSER ERROR]", type: "ParserError", code: "PARSER_ERROR" },
            { prefix: "[COMPILER ERROR]", type: "CompilerError", code: "COMPILER_ERROR" },
            { prefix: "[MINIFIER ERROR]", type: "MinifierError", code: "MINIFIER_ERROR" },
            { prefix: "[VM INVARIANT]", type: "VMInvariantError", code: "VM_INVARIANT" }
        ];
        for (const phase of phaseMatchers) {
            if (rawMsg.startsWith(phase.prefix)) {
                return {
                    type: phase.type,
                    code: phase.code,
                    message: rawMsg
                };
            }
        }
        return {
            type: "SystemError",
            code: "SYSTEM_ERROR",
            message: rawMsg
        };
    }
    return {
        type: "Error",
        code: "ERROR",
        message: String(error ?? "Unknown error")
    };
}

module.exports = {
    root,
    intern,
    dkArrayEnsure,
    dkArrayCreate,
    dkArrayBaseGet,
    dkArrayBaseSet,
    dkBufferCreate,
    toDK,
    toJS,
    formatDKError,
    ...vmTypes,
    Lexer,
    Parser,
    Compiler,
    Minifier,
    DKMin,
    VM
};
