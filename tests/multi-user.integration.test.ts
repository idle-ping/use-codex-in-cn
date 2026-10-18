import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname;
async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as any).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}
async function waitFor(check: () => Promise<any>) {
  for (let i = 0; i < 300; i++) {
    const result = await check();
    if (result) return result;
    await Bun.sleep(30);
  }
  throw new Error("multi-user server did not become ready");
}

test("authenticates users and gives each user an isolated runtime", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "webui-multi-user-"));
  const bin = join(rootDir, "bin"); mkdirSync(bin);
  const codex = join(bin, "codex");
  Bun.write(codex, `#!/usr/bin/env node
const readline = require('node:readline');
const threads = new Map();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => { const m = JSON.parse(line); let result = { ok: true };
  if (m.method === 'initialize') result = { codexHome: process.env.CODEX_HOME };
  if (m.method === 'thread/start') { const id = 'thread-' + Math.random().toString(36).slice(2); const thread = { id, cwd: m.params.cwd, canAcceptDirectInput: true, turns: [] }; threads.set(id, thread); result = { thread }; }
  if (m.method === 'thread/read') result = { thread: threads.get(m.params.threadId) || null };
  if (m.method === 'thread/list') result = { data: [...threads.values()] };
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
});
`);
  chmodSync(codex, 0o700);
  const port = await freePort();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOST: "127.0.0.1", PORT: String(port), CODEX_WEBUI_MULTI_USER: "true", CODEX_WEBUI_MULTI_USER_ROOT: join(rootDir, "data"), CODEX_WEBUI_AUTH_DATABASE: join(rootDir, "data", "control", "auth.sqlite"), CODEX_WEBUI_PROJECTLESS: "false" };
  const child = Bun.spawn(["bun", "run", "server.ts"], { cwd: root, env, stdout: "ignore", stderr: "pipe" });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => { try { return await fetch(`${base}/api/auth/status`).then(r => r.ok); } catch { return false; } });
    const password = "correct horse battery staple";
    const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password }) });
    expect(setup.status).toBe(200);
    const aliceCookie = setup.headers.get("set-cookie")!.split(";")[0];
    const create = await fetch(`${base}/api/auth/users`, { method: "POST", headers: { cookie: aliceCookie, "content-type": "application/json" }, body: JSON.stringify({ username: "bob", password }) });
    expect(create.status).toBe(201);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bob", password }) });
    expect(login.status).toBe(200);
    const bobCookie = login.headers.get("set-cookie")!.split(";")[0];
    const aliceConfig = await fetch(`${base}/api/config`, { headers: { cookie: aliceCookie } }).then(r => r.json());
    const bobConfig = await fetch(`${base}/api/config`, { headers: { cookie: bobCookie } }).then(r => r.json());
    expect(aliceConfig.defaultCwd).not.toBe(bobConfig.defaultCwd);
    const rpc = (cookie: string, method: string, params: any) => fetch(`${base}/api/rpc`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "rpc", id: 1, method, params }) }).then(r => r.json());
    const started = await rpc(aliceCookie, "thread/start", { cwd: "/etc" });
    expect(started.type).toBe("rpc/result");
    expect(started.result.thread.cwd).toBe(aliceConfig.defaultCwd);
    const list = await rpc(bobCookie, "thread/list", {});
    expect(list.result.data).toEqual([]);
  } finally {
    child.kill("SIGTERM"); await child.exited;
    rmSync(rootDir, { recursive: true, force: true });
  }
}, 30_000);
