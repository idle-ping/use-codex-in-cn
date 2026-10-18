import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMultiUserConfig } from "../multi-user-config.ts";
import { migrateSingleUser } from "../migration-service.ts";

test("copies single-user Codex, workspace and uploads data with a migration marker", () => {
  const root = mkdtempSync(join(tmpdir(), "webui-migration-"));
  try {
    const sourceHome = join(root, "old-codex"), sourceWorkspace = join(root, "old-workspace");
    mkdirSync(join(sourceHome, "sessions"), { recursive: true }); mkdirSync(sourceWorkspace, { recursive: true });
    writeFileSync(join(sourceHome, "sessions", "rollout.jsonl"), "session\n");
    writeFileSync(join(sourceWorkspace, "README.md"), "workspace\n");
    mkdirSync(join(sourceHome, "codex-webui-uploads")); writeFileSync(join(sourceHome, "codex-webui-uploads", "a.txt"), "upload\n");
    const config = loadMultiUserConfig({ CODEX_WEBUI_MULTI_USER_ROOT: join(root, "data"), CODEX_WEBUI_MULTI_USER: "true" });
    const result = migrateSingleUser({ sourceHome, sourceWorkspace, config, userId: "user-1", now: 123 });
    expect(readFileSync(join(result.plan.destination.codexHome, "sessions", "rollout.jsonl"), "utf8")).toContain("session");
    expect(readFileSync(join(result.plan.destination.workspace, "README.md"), "utf8")).toContain("workspace");
    expect(readFileSync(join(result.plan.destination.uploads, "a.txt"), "utf8")).toContain("upload");
    expect(existsSync(join(result.plan.destination.codexHome, "codex-webui-uploads", "a.txt"))).toBe(false);
    expect(statSync(join(result.plan.destination.metadata, "migration.json")).mode & 0o777).toBe(0o600);
    expect(() => migrateSingleUser({ sourceHome, sourceWorkspace, config, userId: "user-1" })).toThrow("marker");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
