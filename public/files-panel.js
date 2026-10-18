import { codexIcon } from './codex-icons.js';

const MAX_FILE_PREVIEW_BYTES = 512 * 1024;

function fileName(path = '') { return String(path).split('/').filter(Boolean).at(-1) || path || 'Files'; }
function formatBytes(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function createFilesPanel({
  t = value => value,
  onOpenFile = () => {},
  onChooseProject = () => {},
  shortPath = value => value,
} = {}) {
  const panel = document.querySelector('#filesPanel');
  const title = document.querySelector('#filesPanelTitle');
  const pathLabel = document.querySelector('#filesPanelPath');
  const searchInput = document.querySelector('#filesSearch');
  const searchClear = document.querySelector('#filesSearchClear');
  const refresh = document.querySelector('#filesPanelRefresh');
  const status = document.querySelector('#filesPanelStatus');
  const tree = document.querySelector('#filesTree');
  const viewButtons = [...document.querySelectorAll('[data-files-view]')];
  const gitViewButton = document.querySelector('[data-files-view="git"]');
  const gitCount = document.querySelector('#filesGitCount');
  if (!panel || !title || !pathLabel || !searchInput || !searchClear || !refresh || !status || !tree) return null;

  const state = { cwd: '', project: '', view: 'files', expanded: new Set(), gitExpanded: new Set(['changes', 'unversioned']), loaded: new Map(), gitStatus: new Map(), gitEntries: [], gitAvailable: false, requestId: 0, gitRequestId: 0, searchRequestId: 0, searchTimer: null, searching: false };

  function setStatus(message = '') {
    status.textContent = message ? t(message) : '';
    status.hidden = !message;
  }

  function emptyState(message, action = null) {
    tree.replaceChildren();
    const wrapper = document.createElement('div');
    wrapper.className = 'files-empty';
    const text = document.createElement('p');
    text.textContent = t(message);
    wrapper.append(text);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'files-empty-action';
      button.textContent = t(action.label);
      button.onclick = action.onClick;
      wrapper.append(button);
    }
    tree.append(wrapper);
  }

  function gitCode(entry) {
    const status = String(entry?.status || '').trim();
    if (!status || status === ' ') return '';
    if (status === '??' || status.includes('?')) return 'U';
    if (status.includes('U')) return 'C';
    if (status.includes('D')) return 'D';
    if (status.includes('R')) return 'R';
    if (status.includes('A')) return 'A';
    return 'M';
  }

  function isUnversioned(entry) {
    return String(entry?.status || '') === '??' || (entry?.indexStatus === '?' && entry?.worktreeStatus === '?');
  }

  function gitLabel(code) {
    return ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Conflict', U: 'Unversioned' })[code] || 'Changed';
  }

  function updateGitCount() {
    if (!gitCount) return;
    const count = state.gitEntries.length;
    gitCount.textContent = count ? String(count) : '';
    gitCount.hidden = !count;
  }

  function setGitViewAvailable(available) {
    if (gitViewButton) gitViewButton.hidden = !available;
    if (available || state.view !== 'git') return;
    state.view = 'files';
    state.searchRequestId += 1;
    state.searching = false;
    searchInput.closest('.files-search').hidden = false;
    viewButtons.forEach(button => {
      const active = button.dataset.filesView === 'files';
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    title.textContent = t('Files');
    renderTree(state.loaded.get('') || { entries: [] });
  }

  function createGitTree(entries) {
    const root = { kind: 'directory', name: '', path: '', children: new Map(), entries: [] };
    for (const entry of entries) {
      const parts = String(entry.path || '').split('/').filter(Boolean);
      if (!parts.length) continue;
      let node = root;
      let path = '';
      parts.forEach((part, index) => {
        path = path ? `${path}/${part}` : part;
        const leaf = index === parts.length - 1;
        if (!node.children.has(part)) node.children.set(part, leaf
          ? { kind: 'file', name: part, path, entry }
          : { kind: 'directory', name: part, path, children: new Map(), entries: [] });
        node = node.children.get(part);
      });
    }
    return root;
  }

  function resetGitExpansion() {
    state.gitExpanded = new Set(['changes', 'unversioned']);
    for (const [sectionKey, entries] of [['changes', state.gitEntries.filter(entry => !isUnversioned(entry))], ['unversioned', state.gitEntries.filter(isUnversioned)]]) {
      const root = createGitTree(entries);
      for (const child of root.children.values()) if (child.kind === 'directory') state.gitExpanded.add(`${sectionKey}:${child.path}`);
    }
  }

  function gitNodeCount(node) {
    if (node.kind === 'file') return 1;
    return [...node.children.values()].reduce((total, child) => total + gitNodeCount(child), 0);
  }

  function renderGitNode(node, sectionKey, depth = 0) {
    const row = document.createElement('div');
    row.className = `files-tree-row files-git-row files-git-${node.kind}`;
    const code = node.kind === 'file' ? gitCode(node.entry) : '';
    if (code) row.classList.add(`files-git-status-${code.toLowerCase()}`);
    row.style.setProperty('--files-depth', String(depth));
    row.dataset.path = node.path;
    row.dataset.kind = node.kind;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'files-tree-button files-git-button';
    button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(depth + 2));
    button.title = node.path;
    const chevron = document.createElement('span');
    chevron.className = 'files-tree-chevron icon-slot';
    const icon = document.createElement('span');
    icon.className = 'files-tree-icon icon-slot';
    const name = document.createElement('span');
    name.className = 'files-tree-name';
    name.textContent = node.name;
    if (node.kind === 'directory') {
      const key = `${sectionKey}:${node.path}`;
      const open = state.gitExpanded.has(key);
      chevron.innerHTML = codexIcon(open ? 'chevronDown' : 'chevronRight');
      icon.innerHTML = codexIcon('folderOpen');
      button.setAttribute('aria-expanded', String(open));
      const count = document.createElement('small');
      count.className = 'files-git-count';
      count.textContent = String(gitNodeCount(node));
      button.append(chevron, icon, name, count);
      button.onclick = () => {
        if (state.gitExpanded.has(key)) state.gitExpanded.delete(key); else state.gitExpanded.add(key);
        renderGitTree();
      };
      row.append(button);
      if (open) for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) row.append(renderGitNode(child, sectionKey, depth + 1));
      return row;
    }
    chevron.innerHTML = codexIcon('file');
    icon.replaceChildren();
    const location = document.createElement('small');
    location.className = 'files-tree-path';
    location.textContent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    location.title = node.path;
    const badge = document.createElement('small');
    badge.className = `files-tree-git files-tree-git-${code.toLowerCase()}`;
    badge.textContent = code;
    badge.title = `${t(gitLabel(code))} (${node.entry.status})`;
    button.append(chevron, icon, name);
    if (location.textContent) button.append(location);
    button.append(badge);
    button.onclick = () => onOpenFile({ path: node.path, cwd: state.cwd, gitStatus: node.entry });
    row.append(button);
    return row;
  }

  function renderGitSection(label, sectionKey, entries) {
    const section = document.createElement('section');
    section.className = `files-git-section files-git-section-${sectionKey}`;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'files-git-section-header';
    header.setAttribute('role', 'treeitem');
    const open = state.gitExpanded.has(sectionKey);
    header.setAttribute('aria-expanded', String(open));
    const chevron = document.createElement('span');
    chevron.className = 'files-tree-chevron icon-slot';
    chevron.innerHTML = codexIcon(open ? 'chevronDown' : 'chevronRight');
    const title = document.createElement('strong');
    title.textContent = t(label);
    const count = document.createElement('small');
    count.textContent = `${entries.length} ${t(entries.length === 1 ? 'file' : 'files')}`;
    header.append(chevron, title, count);
    header.onclick = () => { if (state.gitExpanded.has(sectionKey)) state.gitExpanded.delete(sectionKey); else state.gitExpanded.add(sectionKey); renderGitTree(); };
    section.append(header);
    if (open) {
      const treeRoot = createGitTree(entries);
      for (const child of [...treeRoot.children.values()].sort((a, b) => a.name.localeCompare(b.name))) section.append(renderGitNode(child, sectionKey));
    }
    return section;
  }

  function renderGitTree() {
    tree.replaceChildren();
    updateGitCount();
    if (!state.gitAvailable) { emptyState('Git status unavailable.'); return; }
    const changes = state.gitEntries.filter(entry => !isUnversioned(entry));
    const unversioned = state.gitEntries.filter(isUnversioned);
    if (!changes.length && !unversioned.length) { emptyState('No local changes.'); return; }
    if (changes.length) tree.append(renderGitSection('Changes', 'changes', changes));
    if (unversioned.length) tree.append(renderGitSection('Unversioned files', 'unversioned', unversioned));
  }

  function renderEntry(entry, depth = 0) {
    const git = state.gitStatus.get(entry.path);
    const row = document.createElement('div');
    row.className = 'files-tree-row';
    row.style.setProperty('--files-depth', String(depth));
    row.dataset.path = entry.path;
    row.dataset.kind = entry.kind;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'files-tree-button';
    button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(depth + 1));
    button.title = entry.path;
    const tooLarge = entry.kind === 'file' && Number(entry.size) > MAX_FILE_PREVIEW_BYTES;
    if (tooLarge) {
      row.classList.add('files-tree-large');
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.title = t('This file is too large to preview.');
    }
    const chevron = document.createElement('span');
    chevron.className = 'files-tree-chevron icon-slot';
    const icon = document.createElement('span');
    icon.className = 'files-tree-icon icon-slot';
    const name = document.createElement('span');
    name.className = 'files-tree-name';
    name.textContent = entry.name || fileName(entry.path);
    if (entry.searchResult && entry.path.includes('/')) {
      const location = document.createElement('small');
      location.className = 'files-tree-path';
      location.textContent = entry.path.slice(0, entry.path.lastIndexOf('/'));
      location.title = entry.path;
      button.append(name, location);
    }
    if (entry.kind === 'directory') {
      const open = state.expanded.has(entry.path);
      chevron.innerHTML = codexIcon(open ? 'chevronDown' : 'chevronRight');
      icon.innerHTML = codexIcon('folderOpen');
      button.setAttribute('aria-expanded', String(open));
      button.onclick = () => toggleDirectory(entry.path);
    } else {
      chevron.innerHTML = codexIcon('file');
      icon.replaceChildren();
      button.onclick = tooLarge ? null : () => onOpenFile({ path: entry.path, cwd: state.cwd, gitStatus: state.gitAvailable ? (git || {}) : null });
    }
    if (!entry.searchResult || !entry.path.includes('/')) button.append(chevron, icon, name);
    else button.prepend(chevron, icon);
    if (tooLarge) {
      const size = document.createElement('small');
      size.className = 'files-tree-size';
      size.textContent = t('Too large');
      button.append(size);
    } else if (entry.kind === 'file' && Number.isFinite(entry.size)) {
      const size = document.createElement('small');
      size.className = 'files-tree-size';
      size.textContent = formatBytes(entry.size);
      button.append(size);
    }
    if (git) {
      const badge = document.createElement('small');
      badge.className = `files-tree-git files-tree-git-${git.status.replace(/[^A-Z?]/g, '').toLowerCase() || 'changed'}`;
      badge.textContent = git.status === '??' ? '?' : git.status.trim();
      badge.title = t('Git status: {status}').replace('{status}', git.status);
      button.append(badge);
    }
    row.append(button);
    if (entry.kind === 'directory' && state.expanded.has(entry.path)) {
      const children = state.loaded.get(entry.path);
      if (children) {
        for (const child of children.entries) row.append(renderEntry(child, depth + 1));
        if (children.truncated) {
          const more = document.createElement('div');
          more.className = 'files-tree-more';
          more.style.setProperty('--files-depth', String(depth + 1));
          more.textContent = t('More files are hidden. Search to find them.');
          row.append(more);
        }
      } else {
        const loading = document.createElement('div');
        loading.className = 'files-tree-loading';
        loading.style.setProperty('--files-depth', String(depth + 1));
        loading.textContent = t('Loading…');
        row.append(loading);
      }
    }
    return row;
  }

  function renderTree(result) {
    tree.replaceChildren();
    if (!result.entries.length) { emptyState('No files in this folder.'); return; }
    for (const entry of result.entries) tree.append(renderEntry(entry));
  }

  async function loadDirectory(path = '', { force = false } = {}) {
    if (!state.cwd) { emptyState('Choose a project to browse files.', { label: 'Choose project folder', onClick: onChooseProject }); return; }
    if (!force && state.loaded.has(path)) return state.loaded.get(path);
    const requestId = ++state.requestId;
    setStatus('Loading files…');
    try {
      const query = new URLSearchParams({ cwd: state.cwd, path });
      const response = await fetch(`/api/workspace/tree?${query}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load files');
      if (requestId !== state.requestId) return null;
      state.loaded.set(result.path || path, result);
      setStatus('');
      if (state.view === 'files') {
        if (path === '') renderTree(result); else renderTree(state.loaded.get('') || { entries: [] });
      }
      return result;
    } catch (error) {
      if (requestId !== state.requestId) return null;
      setStatus(error.message || 'Could not load files');
      if (path === '' && state.view === 'files') emptyState('Could not load files.');
      return null;
    }
  }

  async function loadGitStatus() {
    const requestId = ++state.gitRequestId;
    if (!state.cwd) { state.gitEntries = []; state.gitStatus.clear(); state.gitAvailable = false; setGitViewAvailable(false); if (state.view === 'git') renderGitTree(); return; }
    try {
      const response = await fetch(`/api/git/status?${new URLSearchParams({ cwd: state.cwd })}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Git status unavailable');
      if (requestId !== state.gitRequestId) return;
      const root = String(result.root || '').replaceAll('\\', '/').replace(/\/$/, '');
      const cwd = String(state.cwd || '').replaceAll('\\', '/').replace(/\/$/, '');
      const scope = root && (cwd === root || cwd.startsWith(`${root}/`)) ? cwd.slice(root.length).replace(/^\/+/, '') : '';
      state.gitEntries = (result.entries || []).flatMap(entry => {
        const repoPath = String(entry.path || '').replaceAll('\\', '/');
        if (!repoPath) return [];
        if (scope && repoPath !== scope && !repoPath.startsWith(`${scope}/`)) return [];
        const path = scope ? repoPath.slice(scope.length).replace(/^\/+/, '') : repoPath;
        return path ? [{ ...entry, path, repoPath }] : [];
      });
      state.gitStatus = new Map(state.gitEntries.map(entry => [entry.path, entry]));
      state.gitAvailable = true;
      setGitViewAvailable(true);
      resetGitExpansion();
      if (state.view === 'git') renderGitTree();
    } catch { if (requestId !== state.gitRequestId) return; state.gitEntries = []; state.gitStatus.clear(); state.gitAvailable = false; setGitViewAvailable(false); if (state.view === 'git') renderGitTree(); }
  }

  async function toggleDirectory(path) {
    if (state.expanded.has(path)) state.expanded.delete(path);
    else state.expanded.add(path);
    renderTree(state.loaded.get('') || { entries: [] });
    if (state.expanded.has(path)) await loadDirectory(path);
  }

  async function runSearch(query) {
    const value = query.trim();
    searchClear.hidden = !value;
    if (!value) {
      state.searching = false;
      setStatus('');
      renderTree(state.loaded.get('') || { entries: [] });
      return;
    }
    state.searching = true;
    const requestId = ++state.searchRequestId;
    setStatus('Searching files…');
    try {
      const params = new URLSearchParams({ cwd: state.cwd, query: value });
      const response = await fetch(`/api/files/search?${params}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'File search unavailable');
      if (requestId !== state.searchRequestId || searchInput.value.trim() !== value) return;
      setStatus(result.items?.length ? '' : 'No files found');
      tree.replaceChildren();
      for (const entry of result.items || []) tree.append(renderEntry({ ...entry, name: fileName(entry.path), searchResult: true, kind: entry.kind === 'folder' ? 'directory' : 'file' }));
    } catch (error) {
      if (requestId !== state.searchRequestId) return;
      setStatus(error.message || 'File search unavailable');
      tree.replaceChildren();
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => runSearch(searchInput.value), 180);
  });
  searchClear.onclick = () => { searchInput.value = ''; runSearch(''); searchInput.focus(); };
  viewButtons.forEach(button => button.addEventListener('click', () => {
    const view = button.dataset.filesView;
    if (!view || view === state.view) return;
    state.view = view;
    state.searchRequestId += 1;
    state.searching = false;
    viewButtons.forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
    const gitView = view === 'git';
    searchInput.value = '';
    searchClear.hidden = true;
    searchInput.closest('.files-search').hidden = gitView;
    title.textContent = t(gitView ? 'Git changes' : 'Files');
    if (gitView) renderGitTree(); else renderTree(state.loaded.get('') || { entries: [] });
  }));
  refresh.onclick = () => { state.loaded.clear(); state.expanded.clear(); loadGitStatus().then(() => loadDirectory('')); };

  function open({ cwd = '', project = '' } = {}) {
    state.cwd = cwd;
    state.project = project || fileName(cwd);
    state.view = 'files';
    state.loaded.clear();
    state.gitStatus.clear();
    state.gitEntries = [];
    state.gitExpanded = new Set(['changes', 'unversioned']);
    state.gitAvailable = false;
    setGitViewAvailable(false);
    state.expanded.clear();
    state.requestId += 1;
    state.gitRequestId += 1;
    searchInput.value = '';
    searchClear.hidden = true;
    searchInput.closest('.files-search').hidden = false;
    viewButtons.forEach((button, index) => { const active = index === 0; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    title.textContent = t('Files');
    pathLabel.textContent = shortPath(cwd);
    setStatus('');
    if (!cwd) { emptyState('Choose a project to browse files.', { label: 'Choose project folder', onClick: onChooseProject }); return; }
    loadGitStatus().then(() => loadDirectory(''));
  }

  function close() {
    clearTimeout(state.searchTimer);
    state.requestId += 1;
    state.gitRequestId += 1;
    state.searchRequestId += 1;
  }

  return { open, close, get isOpen() { return !panel.hidden; } };
}
