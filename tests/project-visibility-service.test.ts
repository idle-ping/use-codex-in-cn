import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectVisibilityStore } from '../project-visibility-service.js';
import { normalizeProjectPath } from '../public/project-visibility.js';

test('project identity normalizes home, dot segments and slashes while preserving root and distinct paths', () => {
  expect(normalizeProjectPath('~/work/./alpha/../beta//', '/home/test')).toBe('/home/test/work/beta');
  expect(normalizeProjectPath('/')).toBe('/');
  expect(normalizeProjectPath('/a/alpha')).not.toBe(normalizeProjectPath('/b/alpha'));
  for (const path of ['', 'relative', '__tasks__', '/bad\0path', null]) expect(normalizeProjectPath(path)).toBeNull();
});

test('hidden projects persist independently, snapshots cannot mutate the store and stale Undo cannot override a later hide', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visibility-store-'));
  try {
    const path = join(dir, 'nested', 'visibility.json'), store = new ProjectVisibilityStore(path, '/home/test');
    expect(store.setHidden('~/alpha/', true)).toBe(true);
    const first = store.snapshot(), version = first.hiddenProjects['/home/test/alpha'].hiddenAt;
    expect(store.setHidden('/home/test/alpha', true)).toBe(false);
    store.setHidden('/b/alpha', true);
    const restored = new ProjectVisibilityStore(path, '/home/test');
    expect(restored.snapshot()).toEqual(store.snapshot());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    delete first.hiddenProjects['/home/test/alpha'];
    expect(store.snapshot().hiddenProjects['/home/test/alpha']).toBeDefined();
    expect(store.setHidden('/home/test/alpha', false, version)).toBe(true);
    expect(store.snapshot().hiddenProjects['/b/alpha']).toBeDefined();
    expect(store.setHidden('/home/test/alpha', true)).toBe(true);
    expect(store.snapshot().hiddenProjects['/home/test/alpha'].hiddenAt).toBeGreaterThan(version);
    expect(store.setHidden('/home/test/alpha', false, version)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(store.snapshot());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid requests and failed writes leave visibility intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visibility-write-'));
  try {
    const path = join(dir, 'visibility.json'), store = new ProjectVisibilityStore(path, '/home/test');
    store.setHidden('/alpha', true);
    const before = store.snapshot();
    for (const args of [['__tasks__', true], ['/alpha', 'yes'], ['/alpha', false, -1]]) expect(() => store.setHidden(...args)).toThrow();
    // Prevent replacement without relying on root-dependent permission checks.
    writeFileSync(`${path}.${process.pid}.tmp`, 'occupied');
    expect(() => store.setHidden('/alpha', false)).toThrow();
    expect(store.snapshot()).toEqual(before);
    expect(new ProjectVisibilityStore(path, '/home/test').snapshot()).toEqual(before);
    writeFileSync(path, 'null');
    expect(() => new ProjectVisibilityStore(path, '/home/test')).toThrow('Invalid project visibility store');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
