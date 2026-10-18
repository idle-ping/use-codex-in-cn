import { localDownloadUrl, renderAssistantMarkdown } from './rendering.js';
import { createCodeViewer, languageName } from './code-viewer.js';

// Keep source previews bounded before syntax parsing and layout work begin.
const TEXT_MAX_BYTES = 512 * 1024;
const PDF_MAX_BYTES = 25 * 1024 * 1024;
const MAX_LINES = 20000;
// Normal source files use CodeMirror's incremental highlighting. Bound total
// input and individual lines to keep large/minified files responsive on mobile.
const MAX_HIGHLIGHT_BYTES = 256 * 1024;
const MAX_HIGHLIGHT_LINE = 8 * 1024;
const MAX_OPEN_TABS = 9;

// Read through the existing authenticated file endpoint without navigating to it.
async function readPreview(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('This file is too large to preview.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('This file is too large to preview.');
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

export function createFilePreview({ t = value => value, onBackToFiles = () => {} } = {}) {
  if (!document.querySelector('#filePreviewStyles')) {
    const stylesheet = document.createElement('link');
    stylesheet.id = 'filePreviewStyles';
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/file-preview.css';
    document.head.append(stylesheet);
  }
  const dialog = document.createElement('section');
  dialog.id = 'filePreview';
  dialog.className = 'file-preview';
  dialog.dataset.open = 'false';
  Object.defineProperty(dialog, 'open', { configurable: false, enumerable: true, get: () => dialog.dataset.open === 'true' });
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'false');
  dialog.setAttribute('aria-hidden', 'true');
  dialog.setAttribute('aria-labelledby', 'filePreviewTitle');
  dialog.innerHTML = `<div class="file-preview-shell">
    <header class="file-preview-header">
      <div class="file-preview-heading"><strong id="filePreviewTitle"></strong><small id="filePreviewPath"></small></div>
      <button id="backToFiles" class="file-preview-back" type="button">‹</button><a id="filePreviewDownload"></a><button id="closeFilePreview" type="button">×</button>
    </header>
    <nav class="file-preview-tabs" aria-label="Open files"><button id="closeAllFileTabs" class="file-preview-close-all" type="button"></button></nav>
    <div class="file-preview-toolbar" hidden>
      <button type="button" data-file-view="preview"></button><button type="button" data-file-view="source"></button><button type="button" data-file-view="diff" hidden></button><button type="button" data-file-view="history" hidden></button>
      <span class="file-preview-toolbar-spacer"></span>
      <button type="button" data-file-action="find"></button><button type="button" data-file-action="wrap" aria-pressed="false"></button><button type="button" data-file-action="copy"></button>
      <span class="file-preview-language"></span><span class="file-preview-readonly"></span>
    </div>
    <div id="filePreviewContent" class="file-preview-content" aria-busy="false"></div>
  </div>`;
  const workspace = document.querySelector('#filesDialog .files-dialog-card') || document.body;
  workspace.append(dialog);
  const title = dialog.querySelector('#filePreviewTitle');
  const pathLabel = dialog.querySelector('#filePreviewPath');
  const download = dialog.querySelector('#filePreviewDownload');
  const closeButton = dialog.querySelector('#closeFilePreview');
  const backButton = dialog.querySelector('#backToFiles');
  const tabsHost = dialog.querySelector('.file-preview-tabs');
  const closeAllButton = dialog.querySelector('#closeAllFileTabs');
  const toolbar = dialog.querySelector('.file-preview-toolbar');
  const content = dialog.querySelector('#filePreviewContent');
  const viewButtons = [...toolbar.querySelectorAll('[data-file-view]')];
  const findButton = toolbar.querySelector('[data-file-action="find"]');
  const wrapButton = toolbar.querySelector('[data-file-action="wrap"]');
  const copyButton = toolbar.querySelector('[data-file-action="copy"]');
  const languageLabel = toolbar.querySelector('.file-preview-language');
  const readonlyLabel = toolbar.querySelector('.file-preview-readonly');
  let request = null, gitRequest = null, objectUrl = '', returnFocus = null, editor = null, copyResetTimer = null;
  let wrap = globalThis.matchMedia?.('(max-width:720px), (pointer:coarse)').matches ?? false;
  const tabs = [];
  let activeTab = null;

  function closeAllTabs() {
    tabs.splice(0, tabs.length);
    activeTab = null;
    release();
    renderTabs();
    close();
  }

  function renderTabs() {
    tabsHost.replaceChildren(closeAllButton);
    closeAllButton.textContent = t('Close all');
    closeAllButton.hidden = tabs.length === 0;
    for (const tab of tabs) {
      const item = document.createElement('div'); item.className = `file-preview-tab${tab === activeTab ? ' active' : ''}`;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = tab.name; button.title = tab.path; button.onclick = () => open(tab);
      const closeTab = document.createElement('button'); closeTab.type = 'button'; closeTab.className = 'file-preview-tab-close'; closeTab.textContent = '×'; closeTab.setAttribute('aria-label', `${t('Close')} ${tab.name}`); closeTab.onclick = event => { event.stopPropagation(); const index = tabs.indexOf(tab); tabs.splice(index, 1); if (tab === activeTab) { const next = tabs[index] || tabs[index - 1]; if (next) open(next); else close(); } renderTabs(); };
      item.append(button, closeTab); tabsHost.append(item);
    }
  }

  function release() {
    request?.abort();
    gitRequest?.abort();
    request = null;
    editor?.destroy();
    editor = null;
    clearTimeout(copyResetTimer);
    content.replaceChildren();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    content.setAttribute('aria-busy', 'false');
  }
  function status(message) {
    const element = document.createElement('p');
    element.className = 'file-preview-status';
    element.setAttribute('role', 'status');
    element.textContent = t(message);
    content.replaceChildren(element);
  }
  function isOpen() { return dialog.dataset.open === 'true'; }
  function close() {
    if (!isOpen()) return;
    dialog.dataset.open = 'false';
    dialog.setAttribute('aria-hidden', 'true');
    release();
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
  closeButton.onclick = close;
  backButton.onclick = () => { close(); onBackToFiles(); };

  function renderDiff(diff) {
    const pre = document.createElement('pre');
    pre.className = 'file-preview-diff';
    for (const line of String(diff || '').replace(/\r\n?/g, '\n').split('\n')) {
      const row = document.createElement('div');
      row.className = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-delete' : line.startsWith('@@') || line.startsWith('diff ') ? 'diff-header' : 'diff-context';
      row.textContent = line || ' ';
      pre.append(row);
    }
    content.replaceChildren(pre);
  }

  async function loadGit(kind, details) {
    gitRequest?.abort();
    const controller = new AbortController(); gitRequest = controller;
    try {
      const params = new URLSearchParams({ cwd: details.cwd, path: details.gitStatus?.repoPath || details.path });
      if (kind === 'history') params.set('limit', '50'); else { params.set('scope', details.scope || 'head'); if (details.commit) params.set('commit', details.commit); }
      const response = await fetch(`/api/git/${kind}?${params}`, { signal: controller.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Git data unavailable');
      if (request !== details.controller || controller.signal.aborted) return;
      if (kind === 'diff') { renderDiff(result.diff); return; }
      const list = document.createElement('div'); list.className = 'file-history-list';
      if (!result.items?.length) { status('No Git history found.'); return; }
      for (const item of result.items) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'file-history-item';
        const date = new Date(item.date); button.innerHTML = `<strong></strong><small></small><time></time>`;
        button.querySelector('strong').textContent = `${item.shortHash} ${item.subject}`;
        button.querySelector('small').textContent = item.author;
        button.querySelector('time').textContent = Number.isNaN(date.valueOf()) ? item.date : date.toLocaleString();
        button.onclick = () => loadGit('diff', { ...details, scope: 'commit', commit: item.hash, controller: details.controller });
        list.append(button);
      }
      content.replaceChildren(list);
    } catch (error) { if (!controller.signal.aborted) status(error.message || 'Git data unavailable'); }
  }

  function showText(text, { path, cwd, lineStart, lineEnd, gitStatus }, controller) {
    const markdown = /\.(?:md|markdown|mdown)$/i.test(path);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const syntaxHighlight = new TextEncoder().encode(text).byteLength <= MAX_HIGHLIGHT_BYTES && lines.every(line => line.length <= MAX_HIGHLIGHT_LINE);
    toolbar.hidden = false;
    viewButtons.forEach(button => { button.hidden = button.dataset.fileView === 'diff' || button.dataset.fileView === 'history' ? !gitStatus : !markdown; });
    findButton.hidden = true;
    wrapButton.hidden = true;
    copyButton.hidden = true;
    languageLabel.textContent = languageName(path);
    readonlyLabel.textContent = t('Read only');
    const render = mode => {
      content.scrollTop = 0;
      viewButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fileView === mode)));
      editor?.destroy();
      editor = null;
      if (mode === 'diff') { findButton.hidden = true; wrapButton.hidden = true; copyButton.hidden = true; loadGit('diff', { path, cwd, gitStatus, controller }); return; }
      if (mode === 'history') { findButton.hidden = true; wrapButton.hidden = true; copyButton.hidden = true; loadGit('history', { path, cwd, gitStatus, controller }); return; }
      if (mode === 'preview') {
        findButton.hidden = true;
        wrapButton.hidden = true;
        copyButton.hidden = true;
        const article = document.createElement('article');
        article.className = 'message-text file-preview-markdown';
        article.innerHTML = renderAssistantMarkdown(text, { cwd });
        content.replaceChildren(article);
        return;
      }
      findButton.hidden = false;
      wrapButton.hidden = false;
      copyButton.hidden = false;
      findButton.textContent = t('Find');
      findButton.setAttribute('aria-label', t('Find in file'));
      wrapButton.textContent = wrap ? t('Unwrap') : t('Wrap');
      wrapButton.setAttribute('aria-label', wrap ? t('Disable word wrap') : t('Enable word wrap'));
      wrapButton.setAttribute('aria-pressed', String(wrap));
      copyButton.textContent = t('Copy');
      copyButton.setAttribute('aria-label', t('Copy file'));
      const host = document.createElement('div');
      host.className = 'file-preview-editor';
      content.replaceChildren(host);
      editor = createCodeViewer(host, { text: lines.slice(0, MAX_LINES).join('\n'), path, lineStart, lineEnd, wrap, syntaxHighlight });
      findButton.onclick = () => editor?.find();
      wrapButton.onclick = () => {
        wrap = !wrap;
        editor?.setWrap(wrap);
        wrapButton.textContent = wrap ? t('Unwrap') : t('Wrap');
        wrapButton.setAttribute('aria-label', wrap ? t('Disable word wrap') : t('Enable word wrap'));
        wrapButton.setAttribute('aria-pressed', String(wrap));
      };
      copyButton.onclick = async () => {
        try {
          await editor?.copy();
          copyButton.textContent = t('Copied');
          clearTimeout(copyResetTimer);
          copyResetTimer = setTimeout(() => { if (copyButton.isConnected) copyButton.textContent = t('Copy'); }, 1400);
        } catch {
          copyButton.textContent = t('Copy failed');
          clearTimeout(copyResetTimer);
          copyResetTimer = setTimeout(() => { if (copyButton.isConnected) copyButton.textContent = t('Copy'); }, 1800);
        }
      };
      if (lines.length > MAX_LINES) {
        const notice = document.createElement('p');
        notice.className = 'file-preview-status';
        notice.textContent = t('Only the first 20,000 lines are shown.');
        content.append(notice);
      }
      if (!syntaxHighlight && /\.(?:js|jsx|ts|tsx|json|jsonc|md|markdown|mdown|css|html|htm|py|rs|sql|xml|svg)$/i.test(path)) {
        const notice = document.createElement('p');
        notice.className = 'file-preview-status file-preview-performance-notice';
        notice.textContent = t('Syntax highlighting was disabled for this large file to keep the browser responsive.');
        content.append(notice);
      }
      requestAnimationFrame(() => { if (request === controller && isOpen()) editor?.revealLines(lineStart, lineEnd); });
    };
    for (const button of viewButtons) {
      button.textContent = t(button.dataset.fileView === 'preview' ? 'Preview' : button.dataset.fileView === 'source' ? 'Source' : button.dataset.fileView === 'diff' ? 'Diff' : 'History');
      button.onclick = () => render(button.dataset.fileView);
    }
    render(markdown && !lineStart ? 'preview' : 'source');
  }

  async function open({ path, cwd = '', lineStart = null, lineEnd = null, gitStatus = null, returnFocus: requestedReturnFocus = null }) {
    if (!path) return;
    if (!isOpen()) returnFocus = requestedReturnFocus?.isConnected ? requestedReturnFocus : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const tab = arguments[0];
    let existing = tabs.find(item => item.path === path && item.cwd === cwd);
    if (!existing && tabs.length >= MAX_OPEN_TABS) { status('You can open up to 9 files at once. Close a tab first.'); return; }
    if (!existing) { existing = { path, cwd, lineStart, lineEnd, gitStatus, name: path.split(/[\\/]/).at(-1) || path }; tabs.push(existing); }
    else Object.assign(existing, { lineStart, lineEnd, gitStatus });
    activeTab = existing; renderTabs();
    release();
    const controller = new AbortController();
    request = controller;
    let filename = path.split(/[\\/]/).at(-1) || path;
    try { filename = decodeURIComponent(filename); } catch { /* Preserve literal filenames. */ }
    title.textContent = filename;
    pathLabel.textContent = `${path}${lineStart ? `:${lineStart}${lineEnd ? `-${lineEnd}` : ''}` : ''}`;
    download.textContent = t('Download');
    download.href = localDownloadUrl(path, cwd);
    download.download = filename;
    closeButton.setAttribute('aria-label', t('Close file preview'));
    backButton.setAttribute('aria-label', t('Back to files'));
    toolbar.hidden = true;
    status('Loading file…');
    content.setAttribute('aria-busy', 'true');
    dialog.dataset.open = 'true';
    dialog.setAttribute('aria-hidden', 'false');
    closeButton.focus();
    try {
      const response = await fetch(download.href, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('File unavailable');
      const pdf = /\.pdf$/i.test(filename);
      const blob = await readPreview(response, pdf ? PDF_MAX_BYTES : TEXT_MAX_BYTES);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (request !== controller || !isOpen()) return;
      if (pdf && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-') {
        if (!navigator.pdfViewerEnabled) throw new Error('PDF preview is not available in this browser.');
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const frame = document.createElement('iframe');
        frame.className = 'file-preview-pdf';
        frame.title = filename;
        frame.src = objectUrl;
        content.replaceChildren(frame);
      } else {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('Preview is not available for this file type.'); }
        if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error('Preview is not available for this file type.');
        showText(text, { path, cwd, lineStart, lineEnd, gitStatus }, controller);
      }
    } catch (error) {
      if (request === controller && !controller.signal.aborted) status(error.message || 'File unavailable');
    } finally {
      if (request === controller) content.setAttribute('aria-busy', 'false');
    }
  }
  closeAllButton.onclick = closeAllTabs;
  return { open, close, get isOpen() { return isOpen(); } };
}
