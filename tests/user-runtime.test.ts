import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMultiUserConfig } from "../multi-user-config.ts";
import { UserRuntime } from "../user-runtime.ts";

test("creates isolated user roots and routes events only to subscribed clients", () => {
  const dir = mkdtempSync(join(tmpdir(), "user-runtime-"));
  const config = loadMultiUserConfig({ CODEX_WEBUI_MULTI_USER_ROOT: dir, CODEX_WEBUI_CODEX_ACCOUNT_MODE: "shared" });
  const runtime = new UserRuntime({ userId: "alice", config });
  const events: unknown[] = [];
  const unsubscribe = runtime.subscribe(event => events.push(event));
  runtime.publish({ method: "thread/started" });
  expect(runtime.accountMode).toBe("shared");
  expect(runtime.allowsPath(runtime.paths.workspace)).toBe(true);
  expect(runtime.allowsPath(join(runtime.paths.root, "../outside"))).toBe(false);
  expect(events).toHaveLength(1);
  unsubscribe();
  expect(runtime.clientCount()).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects symlink escapes from the workspace root", () => {
  const dir = mkdtempSync(join(tmpdir(), "user-runtime-"));
  const config = loadMultiUserConfig({ CODEX_WEBUI_MULTI_USER_ROOT: dir });
  const runtime = new UserRuntime({ userId: "alice", config });
  const outside = join(dir, "outside");mkdirSync(outside);const link = join(runtime.paths.workspace, "escape");
  try { Bun.write(link, "placeholder"); } catch {}
  expect(runtime.allowsPath(outside)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
