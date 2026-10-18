import { statSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveAppServerConnection(env, home) {
  const mode = env.CODEX_WEBUI_APP_SERVER_MODE || "auto";
  if (!["auto", "shared", "isolated"].includes(mode)) {
    throw new Error("CODEX_WEBUI_APP_SERVER_MODE must be auto, shared, or isolated");
  }
  if (mode === "isolated") return { mode: "isolated" };
  const socketPath = resolve(env.CODEX_WEBUI_APP_SERVER_SOCKET || join(env.CODEX_HOME || join(home, ".codex"), "app-server-control", "app-server-control.sock"));
  let available = false;
  try { available = statSync(socketPath).isSocket(); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  if (available) return { mode: "shared", socketPath };
  if (mode === "shared" || env.CODEX_WEBUI_APP_SERVER_SOCKET) {
    throw new Error("Codex app-server socket is unavailable. Start the SSH Codex daemon with codex app-server daemon start, and check CODEX_HOME / CODEX_WEBUI_APP_SERVER_SOCKET");
  }
  return { mode: "isolated" };
}
