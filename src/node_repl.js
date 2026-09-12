// src/node_repl.js
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const { Lexer, Parser, Compiler, Minifier, VM, formatDKError } = require("./node_bootstrap");
const { NodeHost } = require("./node_host");
const { runDKFile, createCliLogger } = require("./node_runner");

function prepareReplAST(ast) {
    if (!Array.isArray(ast) || ast.length === 0) return ast;

    const lastIndex = ast.length - 1;
    const lastNode = ast[lastIndex];

    const isExpression = (node) => {
        if (!node) return false;
        if (node.type === "Stmt" && node.value) return isExpression(node.value);
        const exprTypes = [
            "Literal", "StringLiteral", "NumericLiteral", "BooleanLiteral",
            "Identifier", "Var", "Assign", "Call", "Binary",
            "Array", "ArrayLiteral", "MapLiteral", "Dot", "Index", "IndexAtBase", "Slice", "Rebase"
        ];
        return exprTypes.includes(node.type);
    };

    if (isExpression(lastNode)) {
        const exprValue = lastNode.type === "Stmt" ? lastNode.value : lastNode;
        const patched = [...ast];
        patched[lastIndex] = {
            type: "Return",
            value: exprValue,
            line: lastNode.line || 1
        };
        return patched;
    }

    return ast;
}

async function startREPL(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, ".."));
    const cwd = path.resolve(options.cwd || process.cwd());
    
    // Create readline interface first
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "DK> "
    });

    // Pass `rl` as `activeReadline` to the host so they share the same input stream
    const host = options.host || new NodeHost({ projectRoot, cwd, activeReadline: rl });

    const logger = options.logger || createCliLogger({
        sink: (msg) => console.log(msg),
        debug: options.debug
    });

    const vm = new VM(logger);
    vm.host = host;
    vm.currentScriptPath = path.join(cwd, "__repl__.dk");
    vm.Lexer = Lexer;
    vm.Parser = Parser;
    vm.Compiler = Compiler;
    vm.Minifier = Minifier;

    // Only set raw mode to prevent OS local-echo; omit emitKeypressEvents to avoid duplication
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    let inputBuffer = "";
    let isEditorMode = false;
    let editorBuffer = [];

    const executeCode = async (codeToRun) => {
        try {
            const lexer = new Lexer(codeToRun);
            const tokens = lexer.tokenize();
            const parser = new Parser(tokens, null, "REPL");

            if (vm && vm.globals) {
                for (const name of vm.globals.keys()) {
                    parser.scopeStack[0].add(name);
                }
            }
            if (vm && vm.systemTools) {
                for (const name of vm.systemTools.keys()) {
                    parser.scopeStack[0].add(name);
                }
            }

            const ast = parser.parse();
            const replAst = prepareReplAST(ast);
            const compiler = new Compiler(null);
            const fn = compiler.compile(replAst);

            const result = await vm.interpret(fn);

            if (result !== null && result !== undefined) {
                console.log(vm.stringify(result));
            }

            rl.setPrompt("DK> ");
            return true;
        } catch (error) {
            const formatted = formatDKError(error);
            const codePart = formatted.code ? ` [${formatted.code}]` : "";
            console.error(`${formatted.type}${codePart}: ${formatted.message}`);
            rl.setPrompt("DK> ");
            return false;
        }
    };

    process.stdin.on("keypress", async (str, key) => {
        if (!key) return;

        if (isEditorMode && key.ctrl && key.name === "d") {
            if (rl.line) {
                editorBuffer.push(rl.line);
                rl.line = "";
                rl.cursor = 0;
            }

            console.log("\n// Executing...\n");
            const code = editorBuffer.join("\n");
            isEditorMode = false;
            editorBuffer = [];

            await executeCode(code);
            rl.prompt();
        }
    });

    const originalClose = rl.close.bind(rl);
    rl.close = () => {
        if (isEditorMode) {
            if (rl.line) {
                editorBuffer.push(rl.line);
                rl.line = "";
                rl.cursor = 0;
            }

            console.log("\n// Executing...\n");
            const code = editorBuffer.join("\n");
            isEditorMode = false;
            editorBuffer = [];

            if (process.stdin.isPaused()) {
                process.stdin.resume();
            }
            rl.closed = false;

            executeCode(code).then(() => {
                rl.prompt();
            });
            return;
        }
        originalClose();
    };

    rl.on("SIGINT", () => {
        if (isEditorMode) {
            console.log("\n// Editor mode cancelled.");
            isEditorMode = false;
            editorBuffer = [];
            rl.setPrompt("DK> ");
            rl.prompt();
        } else if (inputBuffer) {
            console.log("\n^C (Buffer cleared)");
            inputBuffer = "";
            rl.setPrompt("DK> ");
            rl.prompt();
        } else {
            rl.close();
        }
    });

    rl.prompt();

    rl.on("line", async (line) => {
        const trimmed = line.trim();

        // 1. REPL Commands
        if (!isEditorMode && !inputBuffer) {
            // Check for: run <file>, run "file", .run <file>, .load <file>
            const runMatch = trimmed.match(/^(\.?run|\.?load)\s+(.+)$/i);
            if (runMatch) {
                const rawArg = runMatch[2].trim();
                const targetFile = rawArg.replace(/^["']|["']$/g, "");

                try {
                    let resolvedPath = path.isAbsolute(targetFile)
                        ? targetFile
                        : path.resolve(process.cwd(), targetFile);

                    if (!fs.existsSync(resolvedPath)) {
                        const fallbackPath = path.resolve(projectRoot, targetFile);
                        if (fs.existsSync(fallbackPath)) {
                            resolvedPath = fallbackPath;
                        }
                    }

                    if (!fs.existsSync(resolvedPath)) {
                        const exeDir = path.dirname(process.execPath);
                        const exeFallback = path.resolve(exeDir, targetFile);
                        if (fs.existsSync(exeFallback)) {
                            resolvedPath = exeFallback;
                        }
                    }

                    if (!fs.existsSync(resolvedPath)) {
                        console.error(`Error: File not found: "${targetFile}"`);
                    } else {
                        console.log(`// Running ${resolvedPath}...\n`);
                        await runDKFile(resolvedPath, {
                            projectRoot,
                            cwd,
                            host,
                            logger: createCliLogger({
                                sink: (msg) => console.log(msg),
                                debug: options.debug
                            }),
                            debug: options.debug
                        });
                    }
                } catch (err) {
                    const formatted = formatDKError(err);
                    const codePart = formatted.code ? ` [${formatted.code}]` : "";
                    console.error(`${formatted.type}${codePart}: ${formatted.message}`);
                }

                rl.prompt();
                return;
            }

            if (trimmed === ".help" || trimmed === "help") {
                console.log("DK REPL Commands:");
                console.log("  run <file>   Execute an external .dk script file");
                console.log("  .edit        Enter multi-line script editor mode");
                console.log("  .done        Exit multi-line script mode and execute code");
                console.log("  .exit        Exit the REPL");
                console.log("  .help        Show this help message (but you already knew that!)");
                rl.prompt();
                return;
            }

            if (trimmed === ".exit" || trimmed === "exit()") {
                rl.close();
                return;
            }

            if (trimmed === ".editor" || trimmed === ".edit") {
                isEditorMode = true;
                editorBuffer = [];
                console.log("// Entering editor mode (Ctrl+D or .done to execute, Ctrl+C to cancel)");
                rl.setPrompt("... ");
                rl.prompt();
                return;
            }
        }

        // 2. Editor Mode Collection
        if (isEditorMode) {
            if (trimmed === ".done" || trimmed === ".run") {
                console.log("// Executing...\n");
                const code = editorBuffer.join("\n");
                isEditorMode = false;
                editorBuffer = [];
                await executeCode(code);
                rl.prompt();
                return;
            }

            editorBuffer.push(line);
            rl.setPrompt("... ");
            rl.prompt();
            return;
        }

        // 3. Standard line execution
        inputBuffer += (inputBuffer ? "\n" : "") + line;

        if (!inputBuffer.trim()) {
            inputBuffer = "";
            rl.prompt();
            return;
        }

        try {
            const lexer = new Lexer(inputBuffer);
            const tokens = lexer.tokenize();
            const parser = new Parser(tokens, null, "REPL");

            if (vm && vm.globals) {
                for (const name of vm.globals.keys()) {
                    parser.scopeStack[0].add(name);
                }
            }
            if (vm && vm.systemTools) {
                for (const name of vm.systemTools.keys()) {
                    parser.scopeStack[0].add(name);
                }
            }

            const ast = parser.parse();
            inputBuffer = "";

            const replAst = prepareReplAST(ast);
            const compiler = new Compiler(null);
            const fn = compiler.compile(replAst);

            const result = await vm.interpret(fn);

            if (result !== null && result !== undefined) {
                console.log(vm.stringify(result));
            }

            rl.setPrompt("DK> ");
        } catch (error) {
            const formatted = formatDKError(error);

            if (
                formatted.message.includes("missing terminating") ||
                formatted.message.includes("Unterminated string")
            ) {
                rl.setPrompt("... ");
            } else {
                inputBuffer = "";
                const codePart = formatted.code ? ` [${formatted.code}]` : "";
                console.error(`${formatted.type}${codePart}: ${formatted.message}`);
                rl.setPrompt("DK> ");
            }
        }

        rl.prompt();
    });

    rl.on("close", () => {
        process.exit(0);
    });
}

module.exports = { startREPL };
