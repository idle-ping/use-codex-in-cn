import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_OUTPUT = 4 * 1024 * 1024;
const SENSITIVE = /^(?:\.git(?:\/|$)|\.env(?:\.|$)|node_modules(?:\/|$))/i;
const inside = (candidate, root) => candidate === root || candidate.startsWith(`${root}${sep}`);

function runGit(root, args, { allowFailure = false } = {}) {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = Buffer.from(result.stdout || '');
  if (stdout.byteLength > MAX_OUTPUT) throw new Error('Git output is too large');
  if (result.exitCode !== 0 && !allowFailure) throw new Error(String(result.stderr || 'Git command failed').trim() || 'Git command failed');
  return stdout.toString('utf8');
}

function resolveRepo(cwd, allowedRoots = []) {
  const workspace = realpathSync(resolve(cwd));
  const roots = allowedRoots.flatMap(root => { try { return [realpathSync(resolve(root))]; } catch { return []; } });
  if (!roots.some(root => inside(workspace, root))) throw new Error('Workspace path is outside allowed roots');
  const root = realpathSync(runGit(workspace, ['rev-parse', '--show-toplevel']).trim());
  if (!roots.some(candidate => inside(root, candidate))) throw new Error('Git root is outside allowed roots');
  return { workspace, root };
}

function safePath(repo, path, { allowMissing = false } = {}) {
  const value = String(path || '').trim();
  if (!value || value.includes('\0') || isAbsolute(value) || value.length > 8192 || SENSITIVE.test(value)) throw new Error('Invalid Git path');
  const normalized = value.replaceAll('\\', '/');
  const target = resolve(repo.root, normalized);
  if (!inside(target, repo.root) || normalized.split('/').includes('..')) throw new Error('Invalid Git path');
  try { if (lstatSync(target).isSymbolicLink()) throw new Error('Invalid Git path'); } catch (error) { if (!allowMissing || error?.message === 'Invalid Git path') throw error; }
  return normalized;
}

export function readGitStatus(cwd, allowedRoots = []) {
  const repo = resolveRepo(cwd, allowedRoots);
  const raw = runGit(repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const records = raw.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const indexStatus = record[0] || ' ';
    const worktreeStatus = record[1] || ' ';
    let path = record.slice(3);
    let oldPath;
    if (/^[RC]/.test(indexStatus) || /^[RC]/.test(worktreeStatus)) { oldPath = path; path = records[++i] || path; }
    if (!path || SENSITIVE.test(path)) continue;
    entries.push({ path, oldPath, indexStatus, worktreeStatus, status: `${indexStatus}${worktreeStatus}`.trim() || ' ' });
  }
  return { root: repo.root, entries };
}

export function readGitDiff(cwd, path, { allowedRoots = [], scope = 'head', commit = '' } = {}) {
  const repo = resolveRepo(cwd, allowedRoots);
  const safe = safePath(repo, path, { allowMissing: true });
  let diff;
  if (scope === 'commit') {
    if (!/^[0-9a-f]{7,64}$/i.test(String(commit || ''))) throw new Error('Invalid Git commit');
    diff = runGit(repo.root, ['show', '--format=', '--no-ext-diff', '--no-renames', commit, '--', safe]);
  }
  else if (scope === 'working') diff = runGit(repo.root, ['diff', '--no-ext-diff', '--no-renames', '--', safe]);
  else if (scope === 'staged') diff = runGit(repo.root, ['diff', '--cached', '--no-ext-diff', '--no-renames', '--', safe]);
  else if (scope === 'head') diff = runGit(repo.root, ['diff', 'HEAD', '--no-ext-diff', '--no-renames', '--', safe]);
  else throw new Error('Invalid Git diff scope');
  if (!diff && scope !== 'staged' && scope !== 'commit') {
    const absolute = resolve(repo.root, safe);
    try { statSync(absolute); diff = runGit(repo.root, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', absolute], { allowFailure: true }); } catch { /* deleted files have no synthetic diff */ }
  }
  return { root: repo.root, path: safe, scope, commit: commit || undefined, diff: diff || '' };
}

export function readGitHistory(cwd, path, { allowedRoots = [], limit = 50 } = {}) {
  const repo = resolveRepo(cwd, allowedRoots);
  const safe = safePath(repo, path, { allowMissing: true });
  const max = Math.max(1, Math.min(Number(limit) || 50, 100));
  const fields = runGit(repo.root, ['log', '--follow', `--format=%H%x00%h%x00%an%x00%aI%x00%s%x00`, `-${max}`, '--', safe]).split('\0');
  const items = [];
  for (let i = 0; i + 4 < fields.length && items.length < max; i += 5) {
    if (!fields[i]) continue;
    items.push({ hash: fields[i], shortHash: fields[i + 1], author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4] });
  }
  return { root: repo.root, path: safe, items };
}
