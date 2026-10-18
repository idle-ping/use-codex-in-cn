import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

const root = new URL("..", import.meta.url).pathname;
async function waitFor(check: () => any) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await Bun.sleep(25);
  }
  throw new Error("Shared session check timed out");
}

test("WebUI and an SSH-style client share active input, events, and daemon lifetime", async () => {
  const home = mkdtempSync(join(tmpdir(), "webui-shared-"));
  const socketPath = join(home, "daemon.sock");
  const responses: any[] = [], events: any[] = [];
  const provider = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders(); responses.push(res);
    });
  });
  let daemon: any, webui: any, native: WebSocket | undefined, browser: WebSocket | undefined;
  const pending = new Map();
  let seq = 0;
  const nativeRpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native RPC timeout: ${method}`)); }, 8000);
    pending.set(id, { resolve: (result: any) => { clearTimeout(timer); resolve(result); }, reject: (error: any) => { clearTimeout(timer); reject(error); } });
    native!.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const providerPort = (provider.address() as any).port;
    daemon = Bun.spawn(["codex", "app-server", "--listen", `unix://${socketPath}`,
      "-c", 'model_provider="shared_test"', "-c", 'model="mock"',
      "-c", 'model_providers.shared_test.name="Shared test"',
      "-c", `model_providers.shared_test.base_url="http://127.0.0.1:${providerPort}"`,
      "-c", 'model_providers.shared_test.wire_api="responses"',
      "-c", "model_providers.shared_test.requires_openai_auth=false"],
      { env: { ...process.env, CODEX_HOME: home }, stdout: "ignore", stderr: "ignore" });
    await waitFor(async () => {
      const candidate = new WebSocket(`ws+unix://${socketPath}:/`);
      return new Promise(resolve => {
        candidate.once("open", () => { native = candidate; resolve(true); });
        candidate.on("error", () => resolve(false));
      });
    });
    native!.on("message", raw => {
      const message = JSON.parse(String(raw)), request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
      } else events.push(message);
    });
    await nativeRpc("initialize", { clientInfo: { name: "ssh-session-test", version: "1" }, capabilities: { experimentalApi: true } });
    native!.send(JSON.stringify({ method: "initialized" }));
    const { thread } = await nativeRpc("thread/start", { cwd: home, model: "mock" });
    const { turn } = await nativeRpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "SSH starts this task" }] });
    await waitFor(() => responses.length);

    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as any).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const env = { ...process.env, CODEX_HOME: home, CODEX_WEBUI_APP_SERVER_MODE: "shared", CODEX_WEBUI_APP_SERVER_SOCKET: socketPath,
      HOST: "127.0.0.1", PORT: String(port), CODEX_WEBUI_CWD: home, CODEX_WEBUI_PROJECTLESS: "false", CODEX_WEBUI_PASSWORD: "", CODEX_WEBUI_ACCESS_TOKEN: "shared-test" };
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer shared-test`, "content-type": "application/json" };
    const startWebui = async () => {
      webui = Bun.spawn(["bun", "run", "server.ts"], { cwd: root, env, stdout: "ignore", stderr: "ignore" });
      return waitFor(async () => {
        try { const health = await fetch(`${base}/api/health`, { headers }).then(r => r.json()); return health.codex && health; }
        catch { return false; }
      });
    };
    const health = await startWebui();
    expect(health.appServerMode).toBe("shared");
    expect((await fetch(`${base}/api/rpc`, { method: "POST", body: "{}" })).status).toBe(401);
    const browserEvents: any[] = [];
    browser = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    browser.on("message", raw => browserEvents.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { browser!.once("open", resolve); browser!.once("error", reject); });
    const rpc = async (method: string, params: any) => {
      const result = await fetch(`${base}/api/rpc`, { method: "POST", headers, body: JSON.stringify({ type: "rpc", id: ++seq, method, params }) }).then(r => r.json());
      if (result.type === "rpc/error") throw new Error(result.error);
      return result.result;
    };
    // Opening history must subscribe even when canAcceptDirectInput lets the
    // browser send without an explicit resume.
    const opened = await rpc("host/thread/history", { threadId: thread.id });
    expect(opened.thread.id).toBe(thread.id);
    expect(opened.thread.canAcceptDirectInput).toBe(true);
    const steer = await rpc("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "WebUI adds guidance" }] });
    expect(steer.turnId).toBe(turn.id);
    await waitFor(() => events.some(e => e.method === "item/started" && e.params?.item?.content?.some((c: any) => c.text === "WebUI adds guidance")));
    await nativeRpc("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "SSH adds guidance too" }] });
    await waitFor(() => browserEvents.some(e => e.payload?.method === "item/started" && e.payload.params?.item?.content?.some((c: any) => c.text === "SSH adds guidance too")));
    browser.close(); browser = undefined;
    webui.kill("SIGTERM"); await webui.exited; webui = null;
    expect(daemon.exitCode).toBeNull();
    // Detaching/restarting the WebUI keeps SSH's active turn alive.
    await nativeRpc("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "SSH continues after WebUI closes" }] });
    await startWebui();
    expect((await rpc("thread/resume", { threadId: thread.id })).thread.id).toBe(thread.id);
    await rpc("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    await waitFor(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.id));
    const next = await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "WebUI starts the next task" }] });
    await waitFor(() => events.some(e => e.method === "turn/started" && e.params.turn.id === next.turn.id));
    const queued = await rpc("thread/queue/add", { threadId: thread.id, clientUserMessageId: "shared-queue", input: [{ type: "text", text: "Shared queued message" }] });
    const queue = await nativeRpc("thread/queue/list", { threadId: thread.id });
    expect(queue.data.some((item: any) => item.id === queued.queuedSubmission.id)).toBe(true);
    await nativeRpc("thread/queue/delete", { threadId: thread.id, queuedSubmissionId: queued.queuedSubmission.id });
    await rpc("turn/interrupt", { threadId: thread.id, turnId: next.turn.id });
  } finally {
    browser?.terminate(); native?.terminate();
    for (const request of pending.values()) request.reject(new Error("Test finished"));
    pending.clear();
    for (const child of [webui, daemon]) if (child) { child.kill("SIGTERM"); await child.exited; }
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 45_000);
