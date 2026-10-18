// Use the same lexical path identity in the browser and the visibility store.
export function normalizeProjectPath(path, home = '') {
  if (typeof path !== 'string' || !path || path.includes('\0')) return null;
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1);
  if (!path.startsWith('/')) return null;
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
}
