import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { MultiUserConfig } from "./multi-user-config.ts";
import { userRuntimePaths } from "./multi-user-config.ts";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RuntimeNotification = (message: any) => void;

/**
 * Owns one Codex app-server process and its CODEX_HOME. A runtime never
 * accepts a cwd outside its user's workspace; the server still performs the
 * final path check before forwarding user supplied RPC parameters.
 */
export class MultiUserCodexRuntime {
  readonly userId: string;
  readonly accountMode: MultiUserConfig["accountMode"];
  readonly paths: ReturnType<typeof userRuntimePaths>;
  readonly #config: MultiUserConfig;
  readonly #onNotification: RuntimeNotification;
  #child: ChildProcessWithoutNullStreams | null = null;
  #stdout = "";
  #sequence = 1;
  #pending = new Map<number, Pending>();
  #startPromise: Promise<void> | null = null;
  #stopping = false;
  #connected = false;

  constructor({ userId, config, onNotification }: { userId: string; config: MultiUserConfig; onNotification?: RuntimeNotification }) {
    this.userId = userId;
    this.accountMode = config.accountMode;
    this.#config = config;
    this.paths = userRuntimePaths(config, userId);
    this.#onNotification = onNotification || (() => {});
    for (const path of Object.values(this.paths)) { mkdirSync(path, { recursive: true, mode: 0o700 }); try { chmodSync(path, 0o700); } catch {} }
  }

  get connected() { return this.#connected; }
  get sessionsRoot() { return join(this.paths.codexHome, "sessions"); }

  async start() {
    if (this.#connected) return;
    if (this.#startPromise) return this.#startPromise;
    this.#stopping = false;
    this.#startPromise = this.#launch();
    try { await this.#startPromise; }
    finally { this.#startPromise = null; }
  }

  async request(method: string, params: any = {}) {
    await this.start();
    return this.#sendRequest(method, params);
  }

  respond(id: number, result?: any, error?: any) {
    if (!this.#child || this.#child.exitCode !== null) throw new Error("Codex runtime is not connected");
    this.#child.stdin.write(JSON.stringify(error ? { id, error } : { id, result }) + "\n");
  }

  async stop() {
    this.#stopping = true;
    this.#connected = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex runtime stopped"));
    }
    this.#pending.clear();
    const child = this.#child;
    this.#child = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  async #launch() {
    this.#prepareCredentials();
    const child = spawn("codex", ["app-server", "--stdio"], {
      cwd: this.paths.workspace,
      env: { ...process.env, CODEX_HOME: this.paths.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.#child = child;
    this.#stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.#consume(String(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", data => console.error(`[codex app-server:${this.userId}]`, String(data).trimEnd()));
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = null;
      this.#connected = false;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Codex runtime exited (${code ?? "signal"}${signal ? `/${signal}` : ""})`));
      }
      this.#pending.clear();
      if (!this.#stopping) this.#onNotification({ method: "bridge/status", params: { status: "disconnected", code, signal } });
    });
    await this.#sendRequest("initialize", {
      clientInfo: { name: "codex-webui", title: "Codex WebUI", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    this.#send({ method: "initialized", params: {} });
    this.#connected = true;
    this.#onNotification({ method: "bridge/status", params: { status: "connected" } });
  }

  #sendRequest(method: string, params: any) {
    const id = this.#sequence++;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.#send({ id, method, params });
    return promise;
  }

  #send(message: any) {
    if (!this.#child || this.#child.exitCode !== null) throw new Error("Codex runtime is not connected");
    this.#child.stdin.write(JSON.stringify(message) + "\n");
  }

  #consume(chunk: string) {
    this.#stdout += chunk;
    for (;;) {
      const newline = this.#stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdout.slice(0, newline).trim();
      this.#stdout = this.#stdout.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); }
      catch { console.error(`[codex app-server:${this.userId}] invalid JSON`, line); continue; }
      if (message.id !== undefined && ("result" in message || "error" in message)) {
        const pending = this.#pending.get(Number(message.id));
        if (!pending) continue;
        this.#pending.delete(Number(message.id));
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
        continue;
      }
      this.#onNotification(message);
    }
  }

  #prepareCredentials() {
    if (this.accountMode !== "shared") return;
    const source = this.#config.sharedCodexCredentialRef || join(process.env.CODEX_HOME || join(process.env.HOME || process.cwd(), ".codex"), "auth.json");
    if (!existsSync(source)) return;
    // Codex keeps credentials in auth.json. Copying into the user CODEX_HOME
    // preserves account sharing while keeping sessions and local state apart.
    const target = join(this.paths.codexHome, "auth.json");
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }
}
