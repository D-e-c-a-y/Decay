const fs = require("fs");
const path = require("path");
const { Lexer, Parser, Compiler, Minifier, DKMin, VM } = require("./node_bootstrap");
const { NodeHost } = require("./node_host");

function stripHtml(text) {
    return String(text || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#0?39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function shouldSuppressCliMessage(text, debug) {
    if (!text) return true;
    if (debug) return false;
    return (
        text.startsWith("[VM] ") ||
        text.startsWith("[DEBUG]") ||
        text.startsWith("[NEURAL-TRACE]") ||
        text.startsWith("[ALERT] ") ||
        text.startsWith("[VM: BRAIN]") ||
        text.startsWith("[CRASH]") ||
        text.startsWith("CRASH DUMP:") ||
        text.startsWith("NON-FATAL ERROR:")
    );
}

function createCliLogger(options = {}) {
    const output = options.output || [];
    const sink = typeof options.sink === "function" ? options.sink : null;
    const debug = !!options.debug;
    return (msg) => {
        const plain = stripHtml(msg);
        if (shouldSuppressCliMessage(plain, debug)) return;
        output.push(plain);
        if (sink) sink(plain);
    };
}

async function runDKFile(fileArg, options = {}) {
    const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, ".."));
    const cwd = path.resolve(options.cwd || process.cwd());
    const host = options.host || new NodeHost({ projectRoot, cwd });
    const filePath = host.resolveModulePath(fileArg, { fromPath: path.join(cwd, "__entry__.dk") });
    const source = fs.readFileSync(filePath, "utf8");
    const output = [];
    const logger = options.logger || createCliLogger({
        output,
        sink: options.outputSink,
        debug: options.debug
    });

    const vm = new VM(logger);
    vm.host = host;
    vm.currentScriptPath = filePath;
    vm.Lexer = Lexer;
    vm.Parser = Parser;
    vm.Compiler = Compiler;
    vm.Minifier = Minifier;
    vm.DKMin = DKMin;

    const lexer = new Lexer(source);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens, null, "CLI");
    const ast = parser.parse();
    const compiler = new Compiler(null);
    const fn = compiler.compile(ast);
    await vm.interpret(fn);

    return {
        filePath,
        output
    };
}

module.exports = {
    runDKFile,
    createCliLogger,
    stripHtml
};
