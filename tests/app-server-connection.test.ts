import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAppServerConnection } from "../app-server-connection.js";

test("auto uses the CLI control socket, including its symlink, and isolated overrides it", async () => {
  const home = mkdtempSync(join(tmpdir(), "webui-connection-"));
  const socket = join(home, "daemon.sock");
  const control = join(home, ".codex", "app-server-control", "app-server-control.sock");
  const server = createServer();
  try {
    expect(resolveAppServerConnection({}, home)).toEqual({ mode: "isolated" });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    mkdirSync(join(home, ".codex", "app-server-control"), { recursive: true });
    symlinkSync(socket, control);
    expect(resolveAppServerConnection({}, home)).toEqual({ mode: "shared", socketPath: control });
    expect(resolveAppServerConnection({ CODEX_WEBUI_APP_SERVER_MODE: "isolated" }, home)).toEqual({ mode: "isolated" });
    expect(resolveAppServerConnection({ CODEX_WEBUI_APP_SERVER_SOCKET: socket }, home)).toEqual({ mode: "shared", socketPath: socket });
    expect(resolveAppServerConnection({ CODEX_HOME: join(home, ".codex") }, "/unused")).toEqual({ mode: "shared", socketPath: control });
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("explicit shared connections fail clearly instead of starting another writer", () => {
  const home = mkdtempSync(join(tmpdir(), "webui-connection-"));
  try {
    expect(() => resolveAppServerConnection({ CODEX_WEBUI_APP_SERVER_MODE: "shared" }, home)).toThrow("socket is unavailable");
    expect(() => resolveAppServerConnection({ CODEX_WEBUI_APP_SERVER_SOCKET: join(home, "missing") }, home)).toThrow("socket is unavailable");
    expect(() => resolveAppServerConnection({ CODEX_WEBUI_APP_SERVER_MODE: "wrong" }, home)).toThrow("must be auto, shared, or isolated");
    const file = join(home, "not-a-socket");
    writeFileSync(file, "");
    expect(() => resolveAppServerConnection({ CODEX_WEBUI_APP_SERVER_SOCKET: file }, home)).toThrow("socket is unavailable");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
