import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeProjectPath } from './public/project-visibility.js';

export class ProjectVisibilityStore {
  constructor(path, home) {
    this.path = path;
    this.home = home;
    this.revision = 0;
    this.hiddenProjects = {};
    let data;
    try { data = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!Number.isSafeInteger(data?.revision) || data.revision < 0 || !data.hiddenProjects || typeof data.hiddenProjects !== 'object' || Array.isArray(data.hiddenProjects)) {
      throw new Error('Invalid project visibility store');
    }
    for (const [key, value] of Object.entries(data.hiddenProjects)) {
      if (normalizeProjectPath(key) !== key || !Number.isSafeInteger(value?.hiddenAt) || value.hiddenAt <= 0 || value.hiddenAt > data.revision) {
        throw new Error('Invalid hidden project');
      }
    }
    this.revision = data.revision;
    this.hiddenProjects = data.hiddenProjects;
  }

  snapshot() {
    return { revision: this.revision, hiddenProjects: structuredClone(this.hiddenProjects) };
  }

  setHidden(path, hidden, expectedHiddenAt) {
    const key = normalizeProjectPath(path, this.home);
    if (!key || typeof hidden !== 'boolean') throw new Error('Invalid project visibility request');
    if (expectedHiddenAt !== undefined && (!Number.isSafeInteger(expectedHiddenAt) || expectedHiddenAt <= 0)) throw new Error('Invalid hidden project version');
    const current = this.hiddenProjects[key];
    // An old Undo button must not undo a later hide from another browser.
    if (expectedHiddenAt !== undefined && current?.hiddenAt !== expectedHiddenAt) return false;
    if (Boolean(current) === hidden) return false;
    const revision = Math.max(Date.now(), this.revision + 1);
    const hiddenProjects = { ...this.hiddenProjects };
    if (hidden) hiddenProjects[key] = { hiddenAt: revision };
    else delete hiddenProjects[key];
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ revision, hiddenProjects }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
    this.revision = revision;
    this.hiddenProjects = hiddenProjects;
    return true;
  }
}
