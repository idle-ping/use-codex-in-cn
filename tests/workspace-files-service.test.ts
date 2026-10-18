import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listWorkspaceEntries } from "../workspace-files-service.js";

describe("workspace files service", () => {
  test("lists visible directories before files with paths relative to the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-tree-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "README.md"), "readme");
    writeFileSync(join(root, "src", "app.ts"), "export {};");
    expect(listWorkspaceEntries(root, "", { allowedRoots: [root] })).toEqual({
      cwd: root,
      path: "",
      entries: [
        { name: "src", path: "src", kind: "directory" },
        { name: "README.md", path: "README.md", kind: "file", size: 6 },
      ],
      truncated: false,
    });
  });

  test("rejects traversal and symlink entries", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-tree-"));
    const outside = mkdtempSync(join(tmpdir(), "codex-workspace-outside-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    mkdirSync(join(root, "src"));
    try { symlinkSync(outside, join(root, "linked"), "dir"); } catch { /* Some test environments disallow symlinks. */ }
    expect(() => listWorkspaceEntries(root, "../", { allowedRoots: [root] })).toThrow();
    expect(() => listWorkspaceEntries(root, "missing", { allowedRoots: [root] })).toThrow();
    expect(listWorkspaceEntries(root, "", { allowedRoots: [root] }).entries.some(entry => entry.name === "linked")).toBe(false);
  });

  test("caps and reports large directories", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-tree-"));
    for (let index = 0; index < 4; index += 1) writeFileSync(join(root, `file-${index}.txt`), String(index));
    const result = listWorkspaceEntries(root, "", { allowedRoots: [root], limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
