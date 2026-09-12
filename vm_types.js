var __dk_window = (typeof globalThis !== 'undefined' && globalThis.window)
    ? globalThis.window
    : ((typeof globalThis !== 'undefined') ? globalThis : {});

const OPS = {
    HALT: 0, CONST: 1, POP: 2, DUP: 3, DUP_SECOND: 4,
    ADD: 10, SUB: 11, MUL: 12, DIV: 13, MOD: 14, ADD_ASSIGN: 15, BIT_AND: 16, BIT_OR: 17, BIT_XOR: 18,
    EQ: 20, NEQ: 21, LT: 22, GT: 23, LTE: 24, GTE: 25,
    NOT: 30, AND: 31, OR: 32,
    GET_GLOBAL: 40, SET_GLOBAL: 41, GET_LOCAL: 42, SET_LOCAL: 43,
    GET_FUNCTION_GLOBAL: 44,
    JUMP: 50, JUMP_FALSE: 51, LOOP: 52,
    CALL: 60, RETURN: 61, INVOKE: 62,
    BUILD_ARRAY: 80, BUILD_MAP: 81, GET_INDEX: 82, SET_INDEX: 83, BUILD_VECTOR: 84, ALIAS_KEY: 85,
    BUILD_CLASS: 90, METHOD_DEF: 91, GET_PROP: 92, SET_PROP: 93,
    TRY_BEGIN: 100, TRY_END: 101, THROW: 102,
    UNPACK: 110, BUILD_RANGE: 111, BUILD_REGEX: 112, IMPORT: 113, SLICE: 114, REBASE: 115,
    FOR_RANGE: 116, FOR_RANGE_END: 117, BOOL_SELECT: 118,
    CLOSURE: 120, GET_UPVALUE: 121, SET_UPVALUE: 122, CLOSE_UPVALUE: 123,
    BUILD_NEURAL: 130,
    GET_INDEX_BASE: 131, SET_INDEX_BASE: 132,
    BUILD_BRAIN: 133,
    BUILD_SOLVER: 134
};

const OP_NAMES = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));

// 1. Base Classes
class NativeFunction {
    constructor(name, arity, fn) {
        this.name = name;
        this.arity = arity;
        this.fn = fn;
        this.isNative = true;
    }
}
class ObjFunction { constructor(name) { this.name = name || "<script>"; this.code = []; this.codeLines = []; this.constants = []; this.arity = 0; this.upvalueCount = 0; } }
class ObjClass { constructor(name, superClass = null) { this.name = name; this.superClass = superClass; this.methods = new Map(); } }
class ObjInstance { constructor(klass) { this.klass = klass; this.fields = new Map(); } }
class ObjBoundMethod { constructor(recv, method) { this.receiver = recv; this.method = method; } }
class ObjRange { constructor(start, end) { this.start = start; this.end = end; } }
class ObjUpvalue { constructor(slot) { this.location = slot; this.closed = null; this.isClosed = false; this.next = null; } }

// 2. Closure (Must be before CallFrame)
class ObjClosure { 
    constructor(func) { 
        this.function = func; 
        this.upvalues = []; 
        this.moduleGlobals = null;
    } 
}

// 3. CallFrame (Depends on ObjClosure)
class CallFrame { 
    constructor(closure, ip) { 
        this.closure = closure;
        this.ip = ip; 
        this.bp = 0; // Will be set by VM
    } 
}

// 4. Export
if (typeof __dk_window !== 'undefined') {
    __dk_window.OPS = OPS; __dk_window.OP_NAMES = OP_NAMES;
    __dk_window.NativeFunction = NativeFunction; __dk_window.ObjFunction = ObjFunction;
    __dk_window.ObjClass = ObjClass; __dk_window.ObjInstance = ObjInstance;
    __dk_window.ObjBoundMethod = ObjBoundMethod; __dk_window.ObjRange = ObjRange;
    __dk_window.ObjUpvalue = ObjUpvalue; __dk_window.ObjClosure = ObjClosure;
    __dk_window.CallFrame = CallFrame;
}
if (typeof module !== 'undefined') {
    module.exports = {
        OPS,
        OP_NAMES,
        NativeFunction,
        ObjFunction,
        ObjClass,
        ObjInstance,
        ObjBoundMethod,
        ObjRange,
        ObjUpvalue,
        ObjClosure,
        CallFrame
    };
}
