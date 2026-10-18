import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const skippedDirectories = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", ".cache", ".turbo", "vendor"]);

function inside(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function canonicalRoots(roots = []) {
  return roots.flatMap(root => {
    try { return [realpathSync(resolve(root))]; }
    catch { return []; }
  });
}

function resolveWorkspaceDirectory(cwd, path, allowedRoots) {
  const workspace = realpathSync(resolve(cwd));
  const roots = canonicalRoots(allowedRoots);
  if (!roots.some(root => inside(workspace, root))) throw new Error("Workspace path is outside allowed roots");
  const input = String(path || "").trim();
  if (input.includes("\0") || isAbsolute(input) || input.length > 8192) throw new Error("Invalid workspace path");
  const directory = resolve(workspace, input || ".");
  if (!inside(directory, workspace)) throw new Error("Workspace path is outside the project");
  const canonical = realpathSync(directory);
  if (!inside(canonical, workspace) || !statSync(canonical).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Workspace directory not found");
  return { workspace, directory: canonical, relativePath: relative(workspace, canonical).split(sep).join("/") };
}

export function listWorkspaceEntries(cwd, path = "", { allowedRoots = [], limit = 200 } = {}) {
  const resolved = resolveWorkspaceDirectory(cwd, path, allowedRoots);
  const entries = [];
  for (const entry of readdirSync(resolved.directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = resolve(resolved.directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const relativePath = relative(resolved.workspace, fullPath).split(sep).join("/");
    let size;
    if (entry.isFile()) {
      try { size = statSync(fullPath).size; }
      catch { continue; }
    }
    entries.push({ name: basename(fullPath), path: relativePath, kind: entry.isDirectory() ? "directory" : "file", ...(size == null ? {} : { size }) });
  }
  const max = Math.max(1, Math.min(Number(limit) || 200, 200));
  entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    cwd: resolved.workspace,
    path: resolved.relativePath,
    entries: entries.slice(0, max),
    truncated: entries.length > max,
  };
}
