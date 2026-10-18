import { gzipSync } from "node:zlib";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { defaultBrowseRoots, isDirectory, listFolders, resolveBrowsePath } from "./folder-service.js";
import { applyReviewPatch } from "./review-service.js";
import { ReviewDiffStore, parseReviewPatchRequest } from "./review-state.js";
import { unifiedDiffFromFileChanges } from "./public/codex-surfaces.js";
import { rpcErrorPayload } from "./public/bridge-errors.js";
import { createTerminalSession, normalizeTerminalResize, resolveTerminalCwd } from "./terminal-service.js";
import { readWorkspaceContext } from "./workspace-context.js";
import { searchWorkspaceFiles } from "./file-search.js";
import { listWorkspaceEntries } from "./workspace-files-service.js";
import { readGitDiff, readGitHistory, readGitStatus } from "./git-service.js";
import { resolveLocalFile } from "./file-service.js";
import { resolveLocalImage } from "./image-service.js";
import { LiveSessionStore } from "./live-session-service.js";
import { resolveAppServerConnection } from "./app-server-connection.js";
import { createQueueRecovery } from "./message-queue-service.js";
import { createAutoContinueRecovery } from "./auto-continue-service.js";
import { createConversationHistory } from "./conversation-history-service.js";
import { serveStaticAsset } from "./static-assets.js";
import { readComposerHistory } from "./composer-history-service.js";
import { listSkills } from "./skill-service.js";
import { ProjectVisibilityStore } from "./project-visibility-service.js";
import { GoalStore, goalNotification } from "./goal-service.js";
import { saveAttachment } from "./attachment-service.js";
import { loadMultiUserConfig, userRuntimePaths } from "./multi-user-config.js";
import { MultiUserStore } from "./multi-user-store.js";
import { MultiUserCodexRuntime } from "./multi-user-codex-runtime.js";
import {
  createPasswordSession,
  createStoredPassword,
  isAllowedBrowserRpcMethod,
  isAuthorizedHttpRequest,
  isRequestAuthorized,
  passwordSessionCookie,
  parseCookieHeader,
  resolvePublicAsset,
  resolveSafeRegularFile,
  storedPasswordSessionSecret,
  unauthorizedResponse,
  verifyStoredPassword,
} from "./server-security.js";
import { loadStoredPassword, passwordStorePath, saveStoredPassword, type StoredPassword } from "./password-store.js";
import {
  createAccountIdentityLoader,
  fetchProfileAvatar,
  resolveAccountIdentity,
  toPublicAccountIdentity,
} from "./profile-service.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8899);
const accessToken = process.env.CODEX_WEBUI_ACCESS_TOKEN || null;
const environmentPassword = process.env.CODEX_WEBUI_PASSWORD || null;
const managedPasswordPath = passwordStorePath();
let managedPassword: StoredPassword | null = environmentPassword || accessToken ? null : loadStoredPassword(managedPasswordPath);
let authSecret = environmentPassword || accessToken || storedPasswordSessionSecret(managedPassword);
const multiUserConfig = loadMultiUserConfig();
const multiUserEnabled = multiUserConfig.enabled;
const multiUserStore = multiUserEnabled ? new MultiUserStore({ path: multiUserConfig.authDatabase, rootBase: multiUserConfig.usersRoot }) : null;
const runtimeContext = new AsyncLocalStorage<MultiUserCodexRuntime>();
const multiUserRuntimes = new Map<string, MultiUserCodexRuntime>();
const multiUserProjectVisibility = new Map<string, ProjectVisibilityStore>();
const multiUserGoalStores = new Map<string, GoalStore>();
let passwordSetupInProgress = false;
const localhostOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
const passwordInitialization = process.argv.includes("--setup-password");
if (passwordInitialization && !localhostOnly) {
  throw new Error("Password initialization must listen on localhost. Use HOST=127.0.0.1 bun run server.ts --setup-password");
}
if (!localhostOnly && !authSecret && !multiUserEnabled) {
  throw new Error("Authentication must be configured before listening outside localhost. Set CODEX_WEBUI_PASSWORD or CODEX_WEBUI_ACCESS_TOKEN, or initialize a managed password on localhost with bun run server.ts --setup-password");
}

function multiUserSession(req: IncomingMessage) {
  if (!multiUserStore) return null;
  const token = parseCookieHeader(req.headers.cookie || {}).codex_webui_session;
  return token ? multiUserStore.getSession(token) : null;
}

function authorizedRequest(req: IncomingMessage) {
  return multiUserEnabled ? Boolean(multiUserSession(req)) : isAuthorizedHttpRequest(req, authSecret, !passwordInitialization);
}
const appRoot = existsSync(resolve(import.meta.dir, "public")) ? import.meta.dir : resolve(import.meta.dir, "..");
const publicDir = resolve(appRoot, "public");
const homeDir = process.env.HOME || process.cwd();
// Keep the selected backend across reconnects; silently switching to another
// writer after a daemon disconnect would break shared sessions.
const appServerConnection = resolveAppServerConnection(process.env, homeDir);
const projectless = process.env.CODEX_WEBUI_PROJECTLESS === "true";
const configuredReviewRoot = process.env.CODEX_WEBUI_REVIEW_ROOT || null;
const ntfyTopic = process.env.CODEX_WEBUI_NTFY_TOPIC || null;
const ntfyUrl = (process.env.CODEX_WEBUI_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
if (projectless && !configuredReviewRoot) {
  throw new Error("CODEX_WEBUI_REVIEW_ROOT is required when CODEX_WEBUI_PROJECTLESS=true");
}
const defaultCwd = resolve(process.env.CODEX_WEBUI_CWD || (projectless ? homeDir : appRoot));
const browseRoots = defaultBrowseRoots(homeDir);
const attachmentRoot = resolve(process.env.CODEX_HOME || join(homeDir, ".codex"), "codex-webui-uploads");
const projectVisibility = new ProjectVisibilityStore(resolve(process.env.CODEX_HOME || join(homeDir, ".codex"), "codex-webui-project-visibility.json"), homeDir);
const goalStore = new GoalStore({
  home: homeDir,
  onChange: goal => {
    const notification = goalNotification(goal);
    if (notification) broadcast({ type: "codex/notification", payload: notification });
  },
});
const imageRoots = [...new Set([...browseRoots, attachmentRoot, resolve(tmpdir()), resolve("/tmp")])];
const fileRoots = [...new Set([...browseRoots, attachmentRoot, defaultCwd, resolve(tmpdir()), resolve("/tmp")])];
const reviewRoots = [resolve(configuredReviewRoot || defaultCwd)];
let codexSessionsRoot = resolve(process.env.CODEX_HOME || join(homeDir, ".codex"), "sessions");

type RequestFilesystemContext = {
  home: string;
  defaultCwd: string;
  browseRoots: string[];
  attachmentRoot: string;
  imageRoots: string[];
  fileRoots: string[];
  reviewRoots: string[];
  codexSessionsRoot: string;
};

const singleUserFilesystemContext: RequestFilesystemContext = {
  home: homeDir,
  defaultCwd,
  browseRoots,
  attachmentRoot,
  imageRoots,
  fileRoots,
  reviewRoots,
  codexSessionsRoot,
};

function filesystemContext(req: IncomingMessage): RequestFilesystemContext {
  if (!multiUserEnabled || !multiUserStore) return {
    ...singleUserFilesystemContext,
    // The app-server can discover a different CODEX_HOME during initialize.
    codexSessionsRoot,
  };
  const session = multiUserSession(req);
  if (!session) throw new Error("Authentication required");
  const paths = userRuntimePaths(multiUserConfig, session.user.id);
  for (const path of Object.values(paths)) { mkdirSync(path, { recursive: true, mode: 0o700 }); try { chmodSync(path, 0o700); } catch {} }
  const roots = [paths.workspace];
  return {
    // Treat the workspace as the user's visible home. The runtime root also
    // contains Codex state and must never be exposed through browse expansion.
    home: paths.workspace,
    defaultCwd: paths.workspace,
    browseRoots: roots,
    attachmentRoot: paths.uploads,
    imageRoots: [paths.workspace, paths.uploads, paths.tmp],
    fileRoots: [paths.workspace, paths.uploads, paths.tmp],
    reviewRoots: [paths.workspace],
    codexSessionsRoot: resolve(paths.codexHome, "sessions"),
  };
}

function projectVisibilityForUser(userId?: string) {
  if (!multiUserEnabled || !userId) return projectVisibility;
  let store = multiUserProjectVisibility.get(userId);
  if (!store) {
    const paths = userRuntimePaths(multiUserConfig, userId);
    store = new ProjectVisibilityStore(join(paths.metadata, "project-visibility.json"), paths.root);
    multiUserProjectVisibility.set(userId, store);
  }
  return store;
}

function goalStoreForUser(userId?: string) {
  if (!multiUserEnabled || !userId) return goalStore;
  let store = multiUserGoalStores.get(userId);
  if (!store) {
    const paths = userRuntimePaths(multiUserConfig, userId);
    store = new GoalStore({
      path: join(paths.codexHome, "goals_1.sqlite"),
      home: paths.root,
      onChange: goal => {
        const notification = goalNotification(goal);
        if (notification) broadcastToUser({ type: "codex/notification", payload: notification }, userId);
      },
    });
    store.start();
    multiUserGoalStores.set(userId, store);
  }
  return store;
}
const clients = new Set<WebSocket>();
const clientUsers = new Map<WebSocket, string | null>();
const sseClients = new Map<ServerResponse, string | null>();
const terminalSessions = new Map<WebSocket, ReturnType<typeof createTerminalSession>>();
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const pendingCodexRequests = new Map<number, any>();
const pendingUserCodexRequests = new Map<string, { runtime: MultiUserCodexRuntime; requestId: number; message: any }>();
const autoContinueRecovery = createAutoContinueRecovery(request, (error: Error) => {
  console.error("[codex-webui] automatic continue failed:", error.message);
});
const reviewDiffs = new ReviewDiffStore();
const multiUserReviewDiffs = new Map<string, ReviewDiffStore>();
const liveSessions = new LiveSessionStore();
const recoverMessageQueue = createQueueRecovery(request, (error: Error) => {
  console.error("[codex-webui] queue recovery:", error.message);
});
const multiUserAutoContinue = new Map<string, ReturnType<typeof createAutoContinueRecovery>>();
const multiUserQueueRecovery = new Map<string, ReturnType<typeof createQueueRecovery>>();

function autoContinueForUser(userId?: string) {
  if (!multiUserEnabled || !userId) return autoContinueRecovery;
  let recovery = multiUserAutoContinue.get(userId);
  if (!recovery) {
    const runtime = userCodexRuntime(userId);
    recovery = createAutoContinueRecovery((method, params) => runtime.request(method, params), error => console.error(`[codex-webui:${userId}] automatic continue failed:`, error instanceof Error ? error.message : error));
    multiUserAutoContinue.set(userId, recovery);
  }
  return recovery;
}

function queueRecoveryForUser(userId?: string) {
  if (!multiUserEnabled || !userId) return recoverMessageQueue;
  let recovery = multiUserQueueRecovery.get(userId);
  if (!recovery) {
    const runtime = userCodexRuntime(userId);
    recovery = createQueueRecovery((method, params) => runtime.request(method, params), error => console.error(`[codex-webui:${userId}] queue recovery failed:`, error instanceof Error ? error.message : error));
    multiUserQueueRecovery.set(userId, recovery);
  }
  return recovery;
}
const threadPaths = new Map<string, string>();
const sharedThreadSubscriptions = new Map<string, Promise<void>>();
function threadPathKey(threadId: string) { return `${runtimeContext.getStore()?.userId || "shared"}:${threadId}`; }
const conversationHistory = createConversationHistory({
  readThread: async (threadId: string) => {
    const result=await request("thread/read",{threadId,includeTurns:true});recordThreadPathsFromRpc(result);recordReviewDiffsFromRpc("thread/read",{threadId},result);
    const thread=result.thread;
    try{const live=await readLiveThread(threadId);if(live?.active&&live.turn){const index=thread.turns.findIndex((turn:any)=>turn.id===live.turn.id);const stored=index>=0?thread.turns[index]:null;const opening=stored?.items?.find((item:any)=>item.type==="userMessage");const turn={...stored,...live.turn,items:[...(opening&&!live.turn.items.some((item:any)=>item.id===opening.id)?[opening]:[]),...live.turn.items]};if(index<0)thread.turns.push(turn);else thread.turns[index]=turn}}catch{}
    return thread;
  },
  fingerprint: (threadId: string) => {try{const path=threadPaths.get(threadPathKey(threadId));if(!path)return null;const stat=statSync(path);return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`}catch{return null}},
});
let seq = 1;
let codex: ChildProcessWithoutNullStreams | null = null;
let codexSocket: WebSocket | null = null;
let stdoutBuffer = "";
let connected = false;
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let httpClosed = false;
const accountLoader = createAccountIdentityLoader(async (refresh) => {
  const account = await request("account/read", { refreshToken: refresh });
  return resolveAccountIdentity(account);
});

function reviewDiffStoreForUser(userId?: string) {
  if (!multiUserEnabled || !userId) return reviewDiffs;
  let store = multiUserReviewDiffs.get(userId);
  if (!store) { store = new ReviewDiffStore(); multiUserReviewDiffs.set(userId, store); }
  return store;
}
const multiUserAccountLoaders = new Map<string, ReturnType<typeof createAccountIdentityLoader>>();

function accountLoaderForUser(userId?: string) {
  if (!multiUserEnabled || !userId) return accountLoader;
  let loader = multiUserAccountLoaders.get(userId);
  if (!loader) {
    loader = createAccountIdentityLoader(async refresh => {
      const runtime = userCodexRuntime(userId!);
      return runtimeContext.run(runtime, async () => resolveAccountIdentity(await runtime.request("account/read", { refreshToken: refresh })));
    });
    multiUserAccountLoaders.set(userId, loader);
  }
  return loader;
}

function startCodex() {
  if (shuttingDown) return;
  if (codexSocket) return;
  if (codex && codex.exitCode === null) return;
  if (appServerConnection.mode === "shared") {
    const socket = new WebSocket(`ws+unix://${appServerConnection.socketPath}:/`);
    codexSocket = socket;
    connected = false;
    socket.on("open", () => {
      initialize().catch((error) => {
        console.error("[codex-webui] shared app-server initialize failed:", error.message);
        socket.terminate();
      });
    });
    socket.on("message", (raw) => {
      try { handleCodex(JSON.parse(String(raw))); }
      catch (error) { console.error("[codex-webui] invalid shared app-server message:", error); }
    });
    socket.on("error", (error) => console.error("[codex-webui] shared app-server:", error.message));
    socket.on("close", (code) => {
      if (codexSocket === socket) codexSocket = null;
      handleCodexDisconnect(code, null);
    });
    return;
  }
  const child = spawn("codex", ["app-server", "--stdio"], {
    cwd: defaultCwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  codex = child;
  connected = false;
  stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const pos = stdoutBuffer.indexOf("\n");
      if (pos < 0) break;
      const line = stdoutBuffer.slice(0, pos).trim();
      stdoutBuffer = stdoutBuffer.slice(pos + 1);
      if (!line) continue;
      try { handleCodex(JSON.parse(line)); }
      catch (error) { console.error("[codex-webui] invalid app-server JSON:", line, error); }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => console.error("[codex app-server]", String(data).trimEnd()));
  child.on("exit", (code, signal) => {
    if (codex === child) codex = null;
    handleCodexDisconnect(code, signal);
  });
  initialize().catch((error) => {
    console.error("[codex-webui] initialize failed", error);
    terminateCodex();
  });
}

function handleCodexDisconnect(code: number | null, signal: string | null) {
  connected = false;
  accountLoader.invalidate();
  reviewDiffStoreForUser().clear();
  conversationHistory.clear();
  pendingCodexRequests.clear();
  sharedThreadSubscriptions.clear();
  broadcast({ type: "bridge/status", status: "disconnected", code, signal });
  for (const item of pending.values()) item.reject(new Error("Codex app-server disconnected"));
  pending.clear();
  if (shuttingDown) maybeFinishShutdown();
  else restartTimer = setTimeout(startCodex, 1000);
}

function terminateCodex(signal: NodeJS.Signals = "SIGTERM") {
  // A shared daemon belongs to all clients, including SSH. Only detach WebUI.
  if (codexSocket) { codexSocket.terminate(); return; }
  const child = codex;
  if (!child || child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; }
    catch { /* Fall back to terminating the wrapper process. */ }
  }
  child.kill(signal);
}

function maybeFinishShutdown() {
  if (shuttingDown && httpClosed && !codex && !codexSocket) process.exit(0);
}

function sendRaw(message: any) {
  if (shuttingDown) throw new Error("Codex WebUI is shutting down");
  startCodex();
  if (codexSocket) {
    if (codexSocket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is connecting");
    codexSocket.send(JSON.stringify(message));
    return;
  }
  codex!.stdin.write(JSON.stringify(message) + "\n");
}

function request(method: string, params: any = {}) {
  const runtime = runtimeContext.getStore();
  if (runtime) return runtime.request(method, params);
  const id = seq++;
  sendRaw({ id, method, params });
  return new Promise<any>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex request timed out: ${method}`));
    }, 30000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

function userCodexRuntime(userId: string) {
  let runtime = multiUserRuntimes.get(userId);
  if (runtime) return runtime;
  runtime = new MultiUserCodexRuntime({
    userId,
    config: multiUserConfig,
    onNotification: message => handleUserRuntimeNotification(runtime!, message),
  });
  multiUserRuntimes.set(userId, runtime);
  return runtime;
}

function userMessageText(item: any): string {
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return "";
  return item.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n").trim();
}

function scheduleGoalCommand(threadId: unknown, item: any) {
  if (typeof threadId !== "string" || !threadId) return;
  const text = userMessageText(item).toLowerCase();
  if (text === "/goal resume") {
    void request("thread/goal/set", { threadId, status: "active", origin: "user" }).catch(error => console.error("[codex-webui] goal resume sync failed:", error instanceof Error ? error.message : error));
  } else if (text === "/goal pause") {
    void request("thread/goal/set", { threadId, status: "paused", origin: "user" }).catch(error => console.error("[codex-webui] goal pause sync failed:", error instanceof Error ? error.message : error));
  } else if (text === "/goal clear") {
    void request("thread/goal/clear", { threadId, origin: "user" }).catch(error => console.error("[codex-webui] goal clear sync failed:", error instanceof Error ? error.message : error));
  }
}

async function initialize() {
  const result = await request("initialize", {
    clientInfo: { name: "codex-webui", title: "Codex WebUI", version: "0.2.0" },
    capabilities: { experimentalApi: true },
  });
  sendRaw({ method: "initialized", params: {} });
  if (typeof result?.codexHome === "string") codexSessionsRoot = resolve(result.codexHome, "sessions");
  connected = true;
  broadcast({ type: "bridge/status", status: "connected", info: result });
}

function handleCodex(message: any) {
  if (message.id !== undefined && ("result" in message || "error" in message)) {
    const item = pending.get(Number(message.id));
    if (item) {
      pending.delete(Number(message.id));
      if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else item.resolve(message.result);
      return;
    }
  }
  if (message.id !== undefined && message.method) {
    pendingCodexRequests.set(message.id, message);
    broadcast({ type: "codex/request", payload: message });
    return;
  }
  if (message.method) {
    const threadId = message.params?.threadId;
    autoContinueRecovery.onNotification(message);
    if (message.method === "item/started" || message.method === "item/completed") scheduleGoalCommand(threadId, message.params?.item);
    if(message.params?.threadId)conversationHistory.invalidate(message.params.threadId);
    if (["thread/closed", "thread/deleted"].includes(message.method) && typeof message.params?.threadId === "string") sharedThreadSubscriptions.delete(`shared:${message.params.threadId}`);
    if (message.method === "serverRequest/resolved") pendingCodexRequests.delete(message.params?.requestId);
    if (message.method === "account/updated") accountLoader.invalidate();
    if (message.method === "turn/diff/updated") reviewDiffStoreForUser().record(message.params || {});
    if (message.method === "item/fileChange/patchUpdated") recordFileChangeDiff(message.params || {});
    if (message.method === "item/completed" && message.params?.item?.type === "fileChange") {
      recordFileChangeDiff({ ...message.params, changes: message.params.item.changes });
    }
    if (message.method === "turn/completed") {
      notifyNtfyTurnCompleted(message.params || {});
      void recoverMessageQueue(message.params?.threadId);
    }
    // Keep the server receive time explicit and timezone-safe for browser clients.
    // Native app-server timestamps are Unix seconds; this ISO value is only the
    // fallback for events that do not carry a lifecycle timestamp of their own.
    const payload = { ...message, params: { ...(message.params || {}), webuiReceivedAt: new Date().toISOString() } };
    broadcast({ type: "codex/notification", payload });
  }
}

function handleUserRuntimeNotification(runtime: MultiUserCodexRuntime, message: any) {
  if (message?.method === "bridge/status") {
    if (message.params?.status === "disconnected") {
      for (const [key, item] of pendingUserCodexRequests) if (item.runtime === runtime) pendingUserCodexRequests.delete(key);
      reviewDiffStoreForUser(runtime.userId).clear();
      for (const key of sharedThreadSubscriptions.keys()) if (key.startsWith(`${runtime.userId}:`)) sharedThreadSubscriptions.delete(key);
    }
    broadcast({ type: "bridge/status", ...(message.params || {}) }, runtime);
    return;
  }
  if (message?.id !== undefined && message.method) {
    const key = `${runtime.userId}:${Number(message.id)}`;
    pendingUserCodexRequests.set(key, { runtime, requestId: Number(message.id), message });
    broadcast({ type: "codex/request", payload: message }, runtime);
    return;
  }
  if (!message?.method) return;
  const threadId = message.params?.threadId;
  runtimeContext.run(runtime, () => {
    autoContinueForUser(runtime.userId).onNotification(message);
    if (message.method === "turn/diff/updated") reviewDiffStoreForUser(runtime.userId).record(message.params || {});
    if (message.method === "item/fileChange/patchUpdated") recordFileChangeDiff(message.params || {});
    if (message.method === "item/completed" && message.params?.item?.type === "fileChange") recordFileChangeDiff({ ...message.params, changes: message.params.item.changes });
    if (message.method === "turn/completed") void queueRecoveryForUser(runtime.userId)(threadId);
    if (message.method === "account/updated") accountLoaderForUser(runtime.userId).invalidate();
    if (message.method === "turn/completed") void notifyNtfyTurnCompleted(message.params || {});
  });
  if (threadId) conversationHistory.invalidate(threadId);
  if (["thread/closed", "thread/deleted"].includes(message.method) && typeof threadId === "string") sharedThreadSubscriptions.delete(`${runtime.userId}:${threadId}`);
  if (message.method === "serverRequest/resolved") pendingUserCodexRequests.delete(`${runtime.userId}:${Number(message.params?.requestId)}`);
  const payload = { ...message, params: { ...(message.params || {}), webuiReceivedAt: new Date().toISOString() } };
  broadcast({ type: "codex/notification", payload }, runtime);
}

async function notifyNtfyTurnCompleted(params: any) {
  if (!ntfyTopic) return;
  const turnId = typeof params?.turn?.id === "string" ? params.turn.id : "";
  const threadId = typeof params?.threadId === "string" ? params.threadId : "";
  const body = `Codex task completed${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`;
  try {
    await fetch(`${ntfyUrl}/${encodeURIComponent(ntfyTopic)}`, {
      method: "POST",
      headers: { Title: "Codex task completed", Tags: "white_check_mark", ...(turnId ? { "X-Turn-Id": turnId } : {}) },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("ntfy notification failed:", error instanceof Error ? error.message : error);
  }
}

function recordFileChangeDiff({ threadId, turnId, changes }: any) {
  const diff = unifiedDiffFromFileChanges(Array.isArray(changes) ? changes : []);
  if (diff) reviewDiffStoreForUser(runtimeContext.getStore()?.userId).record({ threadId, turnId, diff });
}

function recordReviewDiffsFromRpc(method: string, params: any, result: any) {
  if (!["thread/read", "thread/resume", "thread/turns/list"].includes(method)) return;
  const threadId = result?.thread?.id || params?.threadId;
  const turns = result?.thread?.turns || result?.data || [];
  if (typeof threadId !== "string" || !Array.isArray(turns)) return;
  for (const turn of turns) {
    const changes = (turn?.items || []).flatMap((item: any) => item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : []);
    const diff = unifiedDiffFromFileChanges(changes);
    if (typeof turn?.id === "string" && diff) reviewDiffStoreForUser(runtimeContext.getStore()?.userId).record({ threadId, turnId: turn.id, diff });
  }
}

function recordThreadPathsFromRpc(result: any) {
  const threads = [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])].filter(Boolean);
  for (const thread of threads) {
    if (typeof thread?.id === "string" && typeof thread?.path === "string") threadPaths.set(threadPathKey(thread.id), thread.path);
  }
}

async function subscribeSharedThread(thread: any) {
  const runtime = runtimeContext.getStore();
  if ((!runtime && appServerConnection.mode !== "shared") || thread?.canAcceptDirectInput !== true) return;
  const key = `${runtime?.userId || "shared"}:${thread.id}`;
  let subscription = sharedThreadSubscriptions.get(key);
  if (!subscription) {
    // Reading history alone does not subscribe this connection to SSH's events
    // or approvals. Resume the already-loaded thread without replacing policy.
    subscription = request("thread/resume", { threadId: thread.id, excludeTurns: true }).then(() => {});
    sharedThreadSubscriptions.set(key, subscription);
    subscription.catch(() => {
      if (sharedThreadSubscriptions.get(key) === subscription) sharedThreadSubscriptions.delete(key);
    });
  }
  await subscription;
}

async function readLiveThread(threadId: unknown) {
  if (typeof threadId !== "string" || !threadId) throw new Error("Invalid thread id");
  let path = threadPaths.get(threadPathKey(threadId));
  if (!path) {
    const result = await request("thread/read", { threadId, includeTurns: false });
    recordThreadPathsFromRpc(result);
    path = threadPaths.get(threadPathKey(threadId));
  }
  if (!path) return { active: false, turn: null, lastEventAt: null };
  const sessionsRoot = runtimeContext.getStore()?.sessionsRoot || codexSessionsRoot;
  const child = relative(sessionsRoot, resolve(path));
  const safePath = child && !child.startsWith("..") ? resolveSafeRegularFile(sessionsRoot, child) : null;
  if (!safePath) throw new Error("Thread rollout is outside the Codex sessions directory");
  return liveSessions.read(safePath);
}

function broadcast(data: any, runtime?: MultiUserCodexRuntime) {
  const text = JSON.stringify(data);
  for (const client of clients) {
    if (runtime && clientUsers.get(client) !== runtime.userId) continue;
    if (client.readyState === WebSocket.OPEN) client.send(text);
  }
  for (const [client, userId] of sseClients) {
    if (runtime && userId !== runtime.userId) continue;
    if (!client.writableEnded) client.write(`data: ${text}\n\n`);
  }
}

function broadcastToUser(data: any, userId?: string | null) {
  if (!userId) return broadcast(data);
  const text = JSON.stringify(data);
  for (const client of clients) if (clientUsers.get(client) === userId && client.readyState === WebSocket.OPEN) client.send(text);
  for (const [client, owner] of sseClients) if (owner === userId && !client.writableEnded) client.write(`data: ${text}\n\n`);
}

function userOwnsThread(userId: string, thread: any) {
  if (!thread || typeof thread.cwd !== "string") return false;
  const workspace = userRuntimePaths(multiUserConfig, userId).workspace;
  const cwd = resolve(thread.cwd);
  return cwd === workspace || cwd.startsWith(`${workspace}/`);
}

async function assertUserThreadAccess(userId: string, threadId: unknown) {
  if (typeof threadId !== "string" || !threadId) throw new Error("Invalid thread id");
  const result = await request("thread/read", { threadId, includeTurns: false });
  recordThreadPathsFromRpc(result);
  if (!userOwnsThread(userId, result?.thread)) throw new Error("Session is not available to this user");
  return result.thread;
}

async function dispatchBrowserMessage(message: any, userId?: string) {
  if (multiUserEnabled && userId) {
    const runtime = userCodexRuntime(userId);
    return runtimeContext.run(runtime, () => dispatchBrowserMessageInternal(message, userId));
  }
  return dispatchBrowserMessageInternal(message, userId);
}

async function dispatchBrowserMessageInternal(message: any, userId?: string) {
  const visibilityStore = projectVisibilityForUser(userId);
  const currentGoalStore = goalStoreForUser(userId);
  const currentAutoContinue = autoContinueForUser(userId);
  const currentQueueRecovery = queueRecoveryForUser(userId);
  const id = message?.id;
  if (message?.type === "rpc") {
    try {
      if (!isAllowedBrowserRpcMethod(message.method)) throw new Error("RPC method is not available to browser clients");
      // This WebUI hint is not part of the native Codex RPC schema.
      const { webuiProjectless, ...params } = message.params || {};
      if (userId && message.method === "thread/start") {
        // A client may request a project path, but a user session is always
        // created below that user's workspace boundary.
        params.cwd = userRuntimePaths(multiUserConfig, userId).workspace;
      }
      if (userId && params.threadId && !["thread/read", "host/thread/history", "host/thread/live", "thread/list"].includes(message.method)) {
        await assertUserThreadAccess(userId, params.threadId);
      }
      if (userId && message.method === "host/thread/live") await assertUserThreadAccess(userId, params.threadId);
      if (message.method === "thread/goal/set") {
        if (typeof params.threadId !== "string" || !params.threadId) throw new Error("Invalid goal thread id");
        if (params.objective !== undefined && (typeof params.objective !== "string" || !params.objective.trim() || params.objective.length > 4000)) throw new Error("Goal objective must contain 1 to 4000 characters");
        if (params.objective === undefined && typeof params.status !== "string") throw new Error("Goal update requires an objective or status");
        // The editor changes only the objective; lifecycle and budgets remain
        // under Codex ownership. Native mutation provenance reflects a Save click.
        const nativeParams = { threadId: params.threadId, origin: "user", ...(params.objective === undefined ? { status: params.status } : { objective: params.objective.trim() }) };
        const result = await request("thread/goal/set", nativeParams);
        currentGoalStore.refresh();
        return { type: "rpc/result", id, result };
      }
      // Any explicit turn supersedes a pending automatic recovery and starts a
      // fresh retry budget for this thread.
      if (["turn/start", "turn/steer"].includes(message.method)) {
        currentAutoContinue.onExplicitInput(params.threadId);
      }
      const result = message.method === "host/thread/history"
        ? await conversationHistory.read(params)
        : message.method === "host/thread/live"
        ? await readLiveThread(params.threadId)
        : await request(message.method, params);
      if (userId && ["thread/read", "host/thread/history", "thread/resume", "thread/start"].includes(message.method)) {
        if (!userOwnsThread(userId, result?.thread)) throw new Error("Session is not available to this user");
      }
      if (userId && message.method === "thread/list" && Array.isArray(result?.data)) {
        result.data = result.data.filter((thread: any) => userOwnsThread(userId, thread));
      }
      if(message.method==="thread/delete")conversationHistory.invalidate(params.threadId);
      recordThreadPathsFromRpc(result);
      recordReviewDiffsFromRpc(message.method, params, result);
      if (["host/thread/history", "thread/read"].includes(message.method)) await subscribeSharedThread(result?.thread);
      if (["host/thread/history", "thread/read"].includes(message.method)) currentGoalStore.emit(result?.thread?.id || params.threadId);
      if (appServerConnection.mode === "shared" && ["thread/start", "thread/resume"].includes(message.method) && result?.thread?.id) {
        sharedThreadSubscriptions.set(`${userId || "shared"}:${result.thread.id}`, Promise.resolve());
      }
      if (message.method === "thread/start" && result?.thread?.id && !webuiProjectless) {
        try {
          if (visibilityStore.setHidden(result.thread.cwd || params.cwd || defaultCwd, false)) {
            broadcast({ type: "projects/visibility", ...visibilityStore.snapshot() }, runtimeContext.getStore());
          }
        } catch (error) {
          // A completed creation must not look like a failed RPC and be retried.
          console.error("[codex-webui] could not restore project visibility:", error);
        }
      }
      if (["thread/resume", "thread/queue/add", "thread/queue/list"].includes(message.method)) void currentQueueRecovery(params.threadId);
      return { type: "rpc/result", id, result, ...(message.method === "thread/start" ? { projectVisibility: visibilityStore.snapshot() } : {}) };
    } catch (error) {
      return rpcErrorPayload(id, error);
    }
  }
  if (message?.type === "codex/response" || message?.type === "codex/error") {
    if (!Number.isSafeInteger(message.requestId)) throw new Error("Invalid Codex request id");
    // Several browser clients can display one approval. Only forward the first answer.
    const runtime = runtimeContext.getStore();
    if (runtime) {
      const key = `${runtime.userId}:${message.requestId}`;
      if (!pendingUserCodexRequests.has(key)) return { type: "ack", id };
      runtime.respond(message.requestId, message.type === "codex/error" ? undefined : message.result, message.type === "codex/error" ? message.error : undefined);
      pendingUserCodexRequests.delete(key);
      broadcast({ type: "codex/notification", payload: { method: "serverRequest/resolved", params: { requestId: message.requestId } } }, runtime);
      return { type: "ack", id };
    }
    if (!pendingCodexRequests.has(message.requestId)) return { type: "ack", id };
    sendRaw(message.type === "codex/error"
      ? { id: message.requestId, error: message.error }
      : { id: message.requestId, result: message.result });
    pendingCodexRequests.delete(message.requestId);
    broadcast({ type: "codex/notification", payload: { method: "serverRequest/resolved", params: { requestId: message.requestId } } });
    return { type: "ack", id };
  }
  if (message?.type === "ping") return { type: "pong" };
  throw new Error("Unsupported browser bridge message");
}

async function handleClient(client: WebSocket, message: any, userId?: string) {
  try { client.send(JSON.stringify(await dispatchBrowserMessage(message, userId))); }
  catch (error) { client.send(JSON.stringify(rpcErrorPayload(message?.id, error))); }
}

function readJsonBody(req: IncomingMessage, maxBytes = 256_000) {
  return new Promise<any>((resolvePromise, reject) => {
    let body = "", tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      if (tooLarge) return;
      if (Buffer.byteLength(body) + Buffer.byteLength(chunk) > maxBytes) { tooLarge = true; return; }
      body += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(new Error("Bridge payload too large"));
      try { resolvePromise(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON payload")); }
    });
  });
}

function passwordSetupRequired() {
  return passwordInitialization && !authSecret;
}

function browserPasswordConfigured() {
  return multiUserEnabled ? Boolean(multiUserStore?.userCount()) : Boolean(environmentPassword || managedPassword || accessToken);
}

function requestMatchesSecret(req: IncomingMessage, submittedPassword: string, expectedSecret: string | null) {
  if (!submittedPassword || !expectedSecret) return false;
  return isRequestAuthorized({
    remoteAddress: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    authorization: `Bearer ${submittedPassword}`,
    accessToken: expectedSecret,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
    forwardedFor: req.headers["x-forwarded-for"],
    forwarded: req.headers.forwarded,
    realIp: req.headers["x-real-ip"],
    allowLoopback: false,
  });
}

function validBrowserPassword(req: IncomingMessage, submittedPassword: string) {
  if (environmentPassword) return requestMatchesSecret(req, submittedPassword, environmentPassword);
  if (managedPassword) {
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) return false;
    return verifyStoredPassword(submittedPassword, managedPassword);
  }
  return requestMatchesSecret(req, submittedPassword, accessToken);
}

function sendAuthError(res: ServerResponse, status: number, error: string, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify({ error }));
}

function publicUser(user: any) {
  if (!user) return null;
  const { rootDirectory: _rootDirectory, ...safe } = user;
  return safe;
}

function issueBrowserSession(req: IncomingMessage, res: ServerResponse) {
  if (!authSecret) throw new Error("Authentication is not configured");
  const session = createPasswordSession(authSecret);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "set-cookie": passwordSessionCookie(session.token, { secure: Boolean((req.socket as any).encrypted) }),
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ ok: true }));
}

function issueMultiUserSession(req: IncomingMessage, res: ServerResponse, userId: string) {
  if (!multiUserStore) throw new Error("Multi-user authentication is not configured");
  const session = multiUserStore.createSession(userId);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "set-cookie": `codex_webui_session=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((session.expiresAt - Date.now()) / 1000)}${(req.socket as any).encrypted ? "; Secure" : ""}`,
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ ok: true, user: publicUser(multiUserStore.getUserById(userId)) }));
}

function encodeContentDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url || "/", "http://localhost"); }
  catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ error: "Invalid request URL" }));
    return;
  }
  const appRoute = req.method === "GET" && (url.pathname === "/" || /^\/settings(?:\/[^/]+)?\/?$/.test(url.pathname));
  const loginAssets = new Set(["/", "/index.html", "/style.css", "/favicon.svg", "/auth-bootstrap.js", "/i18n.js", "/codex-brand.js"]);
  if (url.pathname === "/api/auth/status") {
    const authenticated = authorizedRequest(req);
    const session = multiUserSession(req);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({
      setupRequired: (multiUserEnabled ? !multiUserStore?.userCount() : passwordSetupRequired()) && !authenticated,
      passwordRequired: browserPasswordConfigured(),
      multiUser: multiUserEnabled,
      authenticated,
      ...(session ? { user: publicUser(session.user) } : {}),
    }));
    return;
  }
  if (url.pathname === "/api/auth/setup") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch (error) {
      sendAuthError(res, 400, error instanceof Error ? error.message : "Invalid setup request");
      return;
    }
    const submittedUsername = typeof payload?.username === "string" ? payload.username : "";
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (multiUserEnabled) {
      if (multiUserStore?.userCount()) { sendAuthError(res, 409, "User setup is no longer available"); return; }
      try {
        const user = multiUserStore!.createUser({ username: submittedUsername, password: submittedPassword });
        issueMultiUserSession(req, res, user.id);
      } catch (error: any) { sendAuthError(res, 400, error?.message || "Unable to create user"); }
      return;
    }
    if (submittedPassword.length < 12 || submittedPassword.length > 256) {
      sendAuthError(res, 400, "Password must be between 12 and 256 characters");
      return;
    }
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) {
      sendAuthError(res, 403, "Password setup request was rejected");
      return;
    }
    if (!passwordSetupRequired() || passwordSetupInProgress) {
      sendAuthError(res, 409, "Password setup is no longer available");
      return;
    }
    passwordSetupInProgress = true;
    try {
      const credential = createStoredPassword(submittedPassword) as StoredPassword;
      saveStoredPassword(managedPasswordPath, credential);
      managedPassword = credential;
      authSecret = storedPasswordSessionSecret(credential);
      issueBrowserSession(req, res);
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        try {
          managedPassword = loadStoredPassword(managedPasswordPath);
          authSecret = storedPasswordSessionSecret(managedPassword);
        } catch { /* Keep the original exclusive-create failure as the response. */ }
        sendAuthError(res, 409, "Password setup is no longer available");
      } else {
        console.error("[codex-webui] password setup failed", error);
        sendAuthError(res, 500, "Unable to save the password");
      }
    } finally {
      passwordSetupInProgress = false;
    }
    return;
  }
  if (url.pathname === "/api/auth/login") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch {
      sendAuthError(res, 401, "Incorrect password");
      return;
    }
    const submittedUsername = typeof payload?.username === "string" ? payload.username : "";
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (multiUserEnabled) {
      const user = multiUserStore?.verifyCredentials(submittedUsername, submittedPassword);
      if (!user) { sendAuthError(res, 401, "Incorrect username or password"); return; }
      issueMultiUserSession(req, res, user.id);
      return;
    }
    if (!validBrowserPassword(req, submittedPassword)) {
      sendAuthError(res, 401, "Incorrect password");
      return;
    }
    issueBrowserSession(req, res);
    return;
  }
  if (url.pathname === "/api/auth/users" && multiUserEnabled) {
    const session = multiUserSession(req);
    if (!session) { sendAuthError(res, 401, "Authentication required"); return; }
    if (session.user.role !== "admin") { sendAuthError(res, 403, "Administrator access required"); return; }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ users: multiUserStore!.listUsers().map(publicUser) }));
      return;
    }
    if (req.method !== "POST") { sendAuthError(res, 405, "Method not allowed", { allow: "GET, POST" }); return; }
    try {
      const payload = await readJsonBody(req, 4096);
      const user = multiUserStore!.createUser({ username: payload?.username, password: payload?.password });
      res.writeHead(201, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ user: publicUser(user) }));
    } catch (error: any) { sendAuthError(res, 400, error?.message || "Unable to create user"); }
    return;
  }
  if (url.pathname === "/api/auth/logout" && multiUserEnabled) {
    if (req.method !== "POST") { sendAuthError(res, 405, "Method not allowed", { allow: "POST" }); return; }
    const token = parseCookieHeader(req.headers.cookie || {}).codex_webui_session;
    if (token) multiUserStore?.revokeSession(token);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": "codex_webui_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (!authorizedRequest(req)) {
    if (appRoute || loginAssets.has(url.pathname)) {
      const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
      if (file) {
        serveStaticAsset(req, res, file, mime[extname(file)] || "application/octet-stream");
        return;
      }
    }
    unauthorizedResponse(res);
    return;
  }
  let fsContext: RequestFilesystemContext;
  try { fsContext = filesystemContext(req); }
  catch {
    unauthorizedResponse(res);
    return;
  }
  if (url.pathname === "/api/events") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");
    const userId = multiUserSession(req)?.user.id || null;
    const runtime = userId && multiUserEnabled ? userCodexRuntime(userId) : null;
    const visibilityStore = projectVisibilityForUser(userId || undefined);
    sseClients.set(res, userId);
    res.write(`data: ${JSON.stringify({ type: "projects/visibility", ...visibilityStore.snapshot() })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "bridge/status", status: runtime ? (runtime.connected ? "connected" : "connecting") : (connected ? "connected" : "connecting") })}\n\n`);
    if (runtime) {
      for (const item of pendingUserCodexRequests.values()) if (item.runtime === runtime) res.write(`data: ${JSON.stringify({ type: "codex/request", payload: item.message })}\n\n`);
    } else {
      for (const payload of pendingCodexRequests.values()) res.write(`data: ${JSON.stringify({ type: "codex/request", payload })}\n\n`);
    }
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (url.pathname === "/api/rpc" || url.pathname === "/api/codex/respond") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const payload = await readJsonBody(req);
      const message = url.pathname === "/api/rpc"
        ? { type: "rpc", id: payload.id, method: payload.method, params: payload.params || {} }
        : { type: payload.error ? "codex/error" : "codex/response", id: payload.id, requestId: payload.requestId, result: payload.result, error: payload.error };
      const reply = await dispatchBrowserMessage(message, multiUserSession(req)?.user.id);
      const body=Buffer.from(JSON.stringify(reply));
      const acceptsGzip=String(req.headers["accept-encoding"]||"").split(",").some(value=>{const [encoding,...params]=value.trim().split(";");const quality=params.find(param=>param.trim().startsWith("q="));return encoding==="gzip"&&(!quality||Number(quality.trim().slice(2))>0)});
      const compressed=body.length>1024&&acceptsGzip;
      const payloadBody=compressed?gzipSync(body):body;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", vary: "Accept-Encoding", "content-length":payloadBody.length, ...(compressed?{"content-encoding":"gzip"}:{}) });
      res.end(payloadBody);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/projects/visibility") {
    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const visibilityStore = projectVisibilityForUser(multiUserSession(req)?.user.id);
      if (req.method === "POST") {
        const { project, hidden, expectedHiddenAt } = await readJsonBody(req);
        if (visibilityStore.setHidden(project, hidden, expectedHiddenAt)) broadcastToUser({ type: "projects/visibility", ...visibilityStore.snapshot() }, multiUserSession(req)?.user.id);
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(visibilityStore.snapshot()));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/health") {
    const userId = multiUserSession(req)?.user.id;
    const runtime = userId ? multiUserRuntimes.get(userId) : null;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, codex: multiUserEnabled ? Boolean(runtime?.connected) : connected, version: "0.2.0", appServerMode: multiUserEnabled ? "per-user" : appServerConnection.mode }));
    return;
  }
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ home: fsContext.home, defaultCwd: fsContext.defaultCwd, reviewRoot: fsContext.reviewRoots[0], projectless, multiUser: multiUserEnabled, accountMode: multiUserEnabled ? multiUserConfig.accountMode : "shared" }));
    return;
  }
  if (url.pathname === "/api/skills") {
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return; }
    try {
      const cwd = resolveBrowsePath(url.searchParams.get("cwd") || fsContext.defaultCwd, fsContext.browseRoots, fsContext.home);
      const skills = await listSkills({ cwd, query: url.searchParams.get("query") || "" });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ skills }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/composer/history") {
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return; }
    try {
      const entries = await readComposerHistory(resolve(fsContext.codexSessionsRoot, ".."));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ entries }));
    } catch {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Could not read composer history" }));
    }
    return;
  }
  if (url.pathname === "/api/attachments") {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
    try {
      const attachment = await saveAttachment(req, fsContext.attachmentRoot, url.searchParams.get("name"));
      res.writeHead(201, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ attachment }));
    } catch (error: any) {
      res.writeHead(error.status || 400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error.code ? "Could not save attachment" : error.message }));
    }
    return;
  }
  if (url.pathname === "/api/workspace/context") {
    try {
      const context = readWorkspaceContext(url.searchParams.get("cwd") || fsContext.defaultCwd, fsContext.browseRoots);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(context));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/search") {
    try {
      const cwd = url.searchParams.get("cwd") || fsContext.defaultCwd;
      const query = url.searchParams.get("query") || "";
      const items = await searchWorkspaceFiles(cwd, query, { allowedRoots: fsContext.browseRoots, limit: 30 });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ cwd, query, items }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/workspace/tree") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const cwd = url.searchParams.get("cwd") || fsContext.defaultCwd;
      const path = url.searchParams.get("path") || "";
      const result = listWorkspaceEntries(cwd, path, { allowedRoots: fsContext.fileRoots });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/git/status" || url.pathname === "/api/git/diff" || url.pathname === "/api/git/history") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const cwd = url.searchParams.get("cwd") || fsContext.defaultCwd;
      let result;
      if (url.pathname === "/api/git/status") result = readGitStatus(cwd, fsContext.fileRoots);
      else if (url.pathname === "/api/git/diff") result = readGitDiff(cwd, url.searchParams.get("path"), { allowedRoots: fsContext.fileRoots, scope: url.searchParams.get("scope") || "head", commit: url.searchParams.get("commit") || "" });
      else result = readGitHistory(cwd, url.searchParams.get("path"), { allowedRoots: fsContext.fileRoots, limit: Number(url.searchParams.get("limit") || 50) });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/download") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const file = resolveLocalFile(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || fsContext.defaultCwd,
        home: fsContext.home,
        allowedRoots: fsContext.fileRoots,
      });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeContentDispositionFilename(file.filename)}`,
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      const stream = createReadStream(file.path);
      stream.on("error", () => res.destroy());
      req.on("aborted", () => stream.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "File unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/images/local") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const image = resolveLocalImage(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || fsContext.defaultCwd,
        home: fsContext.home,
        allowedRoots: fsContext.imageRoots,
      });
      res.writeHead(200, {
        "content-type": image.contentType,
        "content-length": String(image.size),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`,
        "cache-control": "private, max-age=60",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      res.end(readFileSync(image.path));
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "Image unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/account" || url.pathname === "/api/account/avatar") {
    try {
      const userId = multiUserSession(req)?.user.id;
      const loader = accountLoaderForUser(userId);
      const account = await loader.get(url.searchParams.get("refresh") === "1");
      if (url.pathname === "/api/account") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify(toPublicAccountIdentity(account)));
        return;
      }
      if (!account.imageUrl) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "No profile avatar" }));
        return;
      }
      const avatar = await fetchProfileAvatar(account.imageUrl);
      res.writeHead(200, {
        "content-type": avatar.contentType,
        "content-length": String(avatar.body.byteLength),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
      res.end(avatar.body);
    } catch (error) {
      console.warn("[codex-webui] account request failed:", error instanceof Error ? error.message : String(error));
      if (url.pathname === "/api/account/avatar") {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Profile avatar unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(toPublicAccountIdentity(await resolveAccountIdentity({ account: null, requiresOpenaiAuth: true }))));
    }
    return;
  }
  if (url.pathname === "/api/folders") {
    try {
      const path = resolveBrowsePath(url.searchParams.get("path") || "~", fsContext.browseRoots, fsContext.home);
      if (!isDirectory(path)) throw new Error("Directory not found");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(listFolders(path, fsContext.browseRoots)));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/review/patch") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy(new Error("Review patch payload too large"));
    });
    req.on("end", async () => {
      let requestPayload: ReturnType<typeof parseReviewPatchRequest> | null = null;
      let operationStarted = false;
      let success = false;
      const userId = multiUserSession(req)?.user.id;
      const runtime = userId && multiUserEnabled ? userCodexRuntime(userId) : null;
      const reviewStore = reviewDiffStoreForUser(userId);
      try {
        const execute = async () => {
          const payload = JSON.parse(body || "{}");
          requestPayload = parseReviewPatchRequest(payload);
          const stored = reviewStore.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);
          operationStarted = true;
          const threadResult = await request("thread/read", { threadId: requestPayload.threadId, includeTurns: false });
          if (userId && !userOwnsThread(userId, threadResult?.thread)) throw new Error("Session is not available to this user");
          const cwd = threadResult?.thread?.cwd;
          if (typeof cwd !== "string" || !cwd) throw new Error("Thread working directory is unavailable");
          const result = await applyReviewPatch({ cwd, diff: stored.diff, action: requestPayload.action }, fsContext.reviewRoots);
          success = true;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(result));
        };
        if (runtime) await runtimeContext.run(runtime, execute);
        else await execute();
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (operationStarted && requestPayload) reviewStore.finish(requestPayload.threadId, requestPayload.turnId, requestPayload.action, success);
      }
    });
    return;
  }
  if (url.pathname.startsWith("/vendor/katex/")) {
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice("/vendor/katex/".length)); }
    catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    const katexDir = resolve(appRoot, "node_modules/katex/dist");
    const file = resolveSafeRegularFile(katexDir, relative);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  if (url.pathname === "/vendor/xterm/xterm.css") {
    const xtermDir = resolve(appRoot, "node_modules/@xterm/xterm/css");
    const file = resolveSafeRegularFile(xtermDir, "xterm.css");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
  }
  serveStaticAsset(req, res, file, mime[extname(file)] || "application/octet-stream");
});

const sseKeepalive = setInterval(() => {
  for (const client of sseClients.keys()) if (!client.writableEnded) client.write(": keepalive\n\n");
}, 25_000);
sseKeepalive.unref();

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true } });
const terminalWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; }
  catch { socket.destroy(); return; }
  if ((pathname !== "/ws" && pathname !== "/terminal") || !authorizedRequest(req)) {
    const body = JSON.stringify({ error: "Authentication required" });
    socket.end([
      "HTTP/1.1 401 Unauthorized",
      "Connection: close",
      'WWW-Authenticate: Basic realm="Codex WebUI", charset="UTF-8"',
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "X-Content-Type-Options: nosniff",
      "",
      body,
    ].join("\r\n"));
    return;
  }
  const target = pathname === "/terminal" ? terminalWss : wss;
  target.handleUpgrade(req, socket, head, client => target.emit("connection", client, req));
});
wss.on("connection", (client, req) => {
  const userId = multiUserSession(req)?.user.id || null;
  clients.add(client);
  clientUsers.set(client, userId);
  const visibilityStore = projectVisibilityForUser(userId || undefined);
  client.send(JSON.stringify({ type: "projects/visibility", ...visibilityStore.snapshot() }));
  const runtime = userId && multiUserEnabled ? userCodexRuntime(userId) : null;
  client.send(JSON.stringify({ type: "bridge/status", status: runtime ? (runtime.connected ? "connected" : "connecting") : (connected ? "connected" : "connecting") }));
  if (runtime) {
    for (const item of pendingUserCodexRequests.values()) if (item.runtime === runtime) client.send(JSON.stringify({ type: "codex/request", payload: item.message }));
  } else {
    for (const payload of pendingCodexRequests.values()) client.send(JSON.stringify({ type: "codex/request", payload }));
  }
  client.on("message", (raw) => {
    try { handleClient(client, JSON.parse(String(raw)), userId || undefined); }
    catch (error) { client.send(JSON.stringify({ type: "rpc/error", error: String(error) })); }
  });
  client.on("close", () => { clients.delete(client); clientUsers.delete(client); });
});
terminalWss.on("connection", (client, req) => {
  let terminal: ReturnType<typeof createTerminalSession> | null = null;
  try {
    const url = new URL(req.url || "/terminal", "http://localhost");
    const context = filesystemContext(req);
    const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), context.browseRoots, context.defaultCwd);
    terminal = createTerminalSession({
      cwd,
      cols: 100,
      rows: 24,
      onData: data => { if (client.readyState === WebSocket.OPEN) client.send(data); },
      onExit: event => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`\r\n[Process exited ${event.exitCode}]\r\n`);
          client.close(1000, "Terminal exited");
        }
      },
    });
    terminalSessions.set(client, terminal);
  } catch (error) {
    console.error("[codex-webui] terminal failed", error);
    client.close(1011, "Terminal unavailable");
    return;
  }
  client.on("message", (raw, isBinary) => {
    if (!terminal || raw.byteLength > 1_000_000) return;
    if (isBinary) {
      terminal.write(Buffer.from(raw as Buffer).toString("utf8"));
      return;
    }
    try {
      const resize = normalizeTerminalResize(JSON.parse(String(raw)));
      if (resize) terminal.resize(resize.cols, resize.rows);
    } catch { /* Terminal input is sent as binary; ignore malformed control frames. */ }
  });
  client.on("close", () => {
    terminalSessions.delete(client);
    terminal?.kill();
    terminal = null;
  });
  client.on("error", () => client.close());
});

const frontendBuild = await Bun.build({
  entrypoints: [resolve(publicDir, "app.js")],
  outdir: publicDir,
  naming: "app.bundle.js",
  target: "browser",
  minify: true,
});
if (!frontendBuild.success) throw new Error(`Frontend build failed: ${frontendBuild.logs.join("\n")}`);

if (!multiUserEnabled) startCodex();
if (!multiUserEnabled) goalStore.start();
server.listen(port, host, () => {
  console.log(`Codex WebUI listening on http://${host}:${port}`);
  if (passwordSetupRequired()) console.warn(`[codex-webui] Local password initialization is required; open the localhost URL to create it in ${managedPasswordPath}`);
  if (!localhostOnly) {
    const addresses = Object.values(networkInterfaces()).flat().filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.family === "IPv4" && !entry.internal);
    for (const entry of addresses) console.log(`LAN: http://${entry.address}:${port} (authentication required)`);
  }
});

function shutdown() {
  if (shuttingDown) return;
  goalStore.stop();
  for (const store of multiUserGoalStores.values()) store.stop();
  multiUserGoalStores.clear();
  shuttingDown = true;
  connected = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  clearInterval(sseKeepalive);
  for (const item of pending.values()) item.reject(new Error("Codex WebUI is shutting down"));
  pending.clear();
  for (const client of clients) client.terminate();
  clients.clear();
  for (const client of sseClients.keys()) client.end();
  sseClients.clear();
  wss.close();
  for (const [client, terminal] of terminalSessions) { terminal.kill(); client.terminate(); }
  terminalSessions.clear();
  terminalWss.close();
  terminateCodex();
  for (const runtime of multiUserRuntimes.values()) void runtime.stop();
  multiUserRuntimes.clear();
  multiUserStore?.close();
  server.close(() => { httpClosed = true; maybeFinishShutdown(); });
  server.closeAllConnections?.();
  const forceExit = setTimeout(() => {
    terminateCodex("SIGKILL");
    process.exit(0);
  }, 5000);
  forceExit.unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
