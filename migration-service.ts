import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { userRuntimePaths, type MultiUserConfig } from "./multi-user-config.ts";

export type SingleUserMigrationOptions = {
  sourceHome: string;
  sourceWorkspace: string;
  sourceUploads?: string;
  config: MultiUserConfig;
  userId: string;
  accountMode?: MultiUserConfig["accountMode"];
  now?: number;
};

export function singleUserMigrationPlan(options: SingleUserMigrationOptions) {
  const sourceHome = resolve(options.sourceHome);
  const sourceWorkspace = resolve(options.sourceWorkspace);
  const sourceUploads = resolve(options.sourceUploads || join(sourceHome, "codex-webui-uploads"));
  const paths = userRuntimePaths(options.config, options.userId);
  return {
    userId: options.userId,
    sourceHome,
    sourceWorkspace,
    sourceUploads,
    destination: paths,
    entries: [
      { source: sourceHome, destination: paths.codexHome, kind: "codex-home" },
      { source: sourceWorkspace, destination: paths.workspace, kind: "workspace" },
      { source: sourceUploads, destination: paths.uploads, kind: "uploads" },
    ],
  };
}

function inside(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

function copyContents(source: string, destination: string, excluded: Set<string> = new Set()) {
  if (!existsSync(source)) return false;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  // Materialize symlinks while copying so the new user tree cannot retain a
  // link into the old user's home or another user's workspace.
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: false, dereference: true, filter: path => ![...excluded].some(root => { const candidate = resolve(path); return candidate === root || candidate.startsWith(`${root}/`); }) });
  return true;
}

export function migrateSingleUser(options: SingleUserMigrationOptions) {
  const plan = singleUserMigrationPlan(options);
  const sourceRoot = resolve(plan.sourceHome);
  const workspace = resolve(plan.sourceWorkspace);
  if (inside(plan.destination.root, sourceRoot) || inside(plan.destination.root, workspace)) throw new Error("Migration destination cannot be inside the source data");
  if (plan.sourceHome === plan.destination.codexHome || plan.sourceWorkspace === plan.destination.workspace) throw new Error("Migration source and destination must differ");
  const markerPath = join(plan.destination.metadata, "migration.json");
  if (existsSync(markerPath)) throw new Error("This user already has a migration marker");
  mkdirSync(plan.destination.root, { recursive: true, mode: 0o700 });
  const excluded = new Set([plan.sourceUploads]);
  const copied = {
    codexHome: copyContents(plan.sourceHome, plan.destination.codexHome, excluded),
    workspace: copyContents(plan.sourceWorkspace, plan.destination.workspace),
    uploads: copyContents(plan.sourceUploads, plan.destination.uploads),
  };
  const marker = {
    version: 1,
    userId: plan.userId,
    accountMode: options.accountMode || options.config.accountMode,
    source: { home: plan.sourceHome, workspace: plan.sourceWorkspace, uploads: plan.sourceUploads },
    copied,
    migratedAtMs: Number(options.now || Date.now()),
  };
  mkdirSync(plan.destination.metadata, { recursive: true, mode: 0o700 });
  writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { plan, marker };
}
