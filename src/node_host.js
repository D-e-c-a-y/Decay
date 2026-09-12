const fs = require("fs");
const path = require("path");
const readline = require("readline");

class NodeHost {
    constructor(options = {}) {
        this.projectRoot = path.resolve(options.projectRoot || process.cwd());
        this.cwd = path.resolve(options.cwd || process.cwd());
        this.dkpListeners = new Map();
        this.dkpChannels = new Map();
        this.nextDKPListenerId = 1;
        this.readline = null;
        this.activeReadline = options.activeReadline || null; // Add this line
        this.capabilities = new Map();
        this.installDefaultCapabilities();
        this.installCapabilities(options.capabilities);
    }

    installDefaultCapabilities() {
        this.capabilities.set("env_get", (name) => {
            const key = String(name || "");
            return Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
        });
        this.capabilities.set("path_join", (...parts) => path.join(...parts.map(part => String(part ?? ""))));
        this.capabilities.set("fs_read", async (specifier, options = {}, meta = {}) => {
            const opts = (options && typeof options === "object" && !Array.isArray(options)) ? options : {};
            const resolved = this.resolveResourcePath(specifier, meta);
            const raw = fs.readFileSync(resolved);
            if (opts.binary) return new Uint8Array(raw);
            return raw.toString("utf8");
        });
        this.capabilities.set("read_line", async (promptMessage) => {
            return await this.readLine(promptMessage);
        });
    }

    installCapabilities(capabilities) {
        if (!capabilities) return;
        if (capabilities instanceof Map) {
            for (const [name, fn] of capabilities.entries()) {
                if (typeof fn === "function") this.capabilities.set(String(name), fn);
            }
            return;
        }
        for (const [name, fn] of Object.entries(capabilities)) {
            if (typeof fn === "function") this.capabilities.set(String(name), fn);
        }
    }

    hasCapability(name) {
        return this.capabilities.has(String(name || ""));
    }

    async callCapability(name, args = [], meta = {}) {
        const key = String(name || "");
        if (!this.capabilities.has(key)) {
            throw new Error(`Host capability '${key}' is not available`);
        }
        const fn = this.capabilities.get(key);
        const list = Array.isArray(args) ? args : [args];
        return await fn(...list, meta);
    }

    getReadLineInterface() {
        if (this.readline) return this.readline;
        if (this.activeReadline) return this.activeReadline; // Reuse REPL instance
        if (!process.stdin || process.stdin.destroyed) return null;
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: !!(process.stdin.isTTY && process.stdout && process.stdout.isTTY)
        });
        rl.on("close", () => {
            if (this.readline === rl) this.readline = null;
        });
        this.readline = rl;
        return rl;
    }

    async readLine(promptMessage = "") {
        const rl = this.getReadLineInterface();
        if (!rl) return null;
        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                rl.off("close", handleClose);
                resolve(value);
            };
            const handleClose = () => {
                if (this.readline === rl) this.readline = null;
                finish(null);
            };
            rl.once("close", handleClose);
            try {
                rl.question(String(promptMessage ?? ""), (answer) => {
                    finish(answer);
                });
            } catch (error) {
                rl.off("close", handleClose);
                reject(error);
            }
        });
    }

    resolveModulePath(specifier, options = {}) {
        const target = String(specifier || "");
        const fromPath = options.fromPath ? path.resolve(options.fromPath) : null;
        const bases = [];
        if (fromPath) bases.push(path.dirname(fromPath));
        bases.push(this.cwd);
        if (!bases.includes(this.projectRoot)) bases.push(this.projectRoot);

        const candidates = [];
        const pushCandidate = (candidate) => {
            if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
        };

        if (path.isAbsolute(target)) {
            pushCandidate(target);
            if (!path.extname(target)) pushCandidate(target + ".dk");
        } else {
            for (const base of bases) {
                const raw = path.resolve(base, target);
                pushCandidate(raw);
                if (!path.extname(raw)) pushCandidate(raw + ".dk");
            }
        }

        for (const candidate of candidates) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        }
        throw new Error(`Module '${target}' was not found`);
    }

    loadModuleSource(specifier, options = {}) {
        const resolved = this.resolveModulePath(specifier, options);
        return {
            path: resolved,
            source: fs.readFileSync(resolved, "utf8")
        };
    }

    resolveResourcePath(specifier, options = {}) {
        const target = String(specifier || "");
        const fromPath = options.fromPath ? path.resolve(options.fromPath) : null;
        const bases = [];
        if (fromPath) bases.push(path.dirname(fromPath));
        bases.push(this.cwd);
        if (!bases.includes(this.projectRoot)) bases.push(this.projectRoot);

        const candidates = [];
        const pushCandidate = (candidate) => {
            if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
        };

        if (path.isAbsolute(target)) {
            pushCandidate(target);
        } else {
            for (const base of bases) {
                pushCandidate(path.resolve(base, target));
            }
        }

        for (const candidate of candidates) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        }
        throw new Error(`Resource '${target}' was not found`);
    }

    async readResource(specifier, options = {}) {
        const resolved = this.resolveResourcePath(specifier, options);
        const raw = fs.readFileSync(resolved);
        if (options.binary) return new Uint8Array(raw);
        return raw.toString("utf8");
    }

    async sendDKPPulse(channel, packet) {
        const key = String(channel || "");
        const listeners = this.dkpChannels.get(key);
        if (!listeners || listeners.size === 0) return false;
        for (const listener of Array.from(listeners)) {
            await listener(packet, key);
        }
        return true;
    }

    listenDKPChannel(channel, listener) {
        const key = String(channel || "");
        const id = "dkp:" + (this.nextDKPListenerId++);
        if (!this.dkpChannels.has(key)) this.dkpChannels.set(key, new Set());
        this.dkpChannels.get(key).add(listener);
        this.dkpListeners.set(id, { channel: key, listener });
        return id;
    }

    unlistenDKPChannel(listenerId) {
        const id = String(listenerId || "");
        const entry = this.dkpListeners.get(id);
        if (!entry) return false;
        this.dkpListeners.delete(id);
        const listeners = this.dkpChannels.get(entry.channel);
        if (listeners) {
            listeners.delete(entry.listener);
            if (listeners.size === 0) this.dkpChannels.delete(entry.channel);
        }
        return true;
    }
}

module.exports = {
    NodeHost
};
