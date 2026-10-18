import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MultiUserCodexRuntime } from "../multi-user-codex-runtime.ts";
import { loadMultiUserConfig } from "../multi-user-config.ts";

test("runs an isolated app-server with a user CODEX_HOME and forwards notifications", async () => {
  const root = mkdtempSync(join(tmpdir(), "webui-runtime-"));
  const bin = join(root, "bin");
  const codex = join(bin, "codex");
  mkdirSync(bin);
  Bun.write(codex, `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => { const m = JSON.parse(line); if (m.id !== undefined) { process.stdout.write(JSON.stringify({ id: m.id, result: m.method === 'initialize' ? { codexHome: process.env.CODEX_HOME } : { ok: true, method: m.method } }) + '\\n'); if (m.method === 'initialize') process.stdout.write(JSON.stringify({ method: 'item/started', params: { threadId: 'thread-1' } }) + '\\n'); } });
`);
  chmodSync(codex, 0o700);
  const config = loadMultiUserConfig({ CODEX_WEBUI_MULTI_USER_ROOT: root, CODEX_WEBUI_MULTI_USER: "true" });
  const notifications: any[] = [];
  const runtime = new MultiUserCodexRuntime({ userId: "user-1", config, onNotification: item => notifications.push(item) });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath || ""}`;
  try {
    const initialized = await runtime.request("thread/list", {});
    expect(initialized).toEqual({ ok: true, method: "thread/list" });
    expect(runtime.paths.codexHome).toContain("users/user-1/codex-home");
    expect(notifications.some(item => item.method === "item/started")).toBe(true);
    expect(notifications.some(item => item.method === "bridge/status" && item.params.status === "connected")).toBe(true);
  } finally {
    await runtime.stop();
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
