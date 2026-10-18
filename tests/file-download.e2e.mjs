import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { launchOptions } from './browser-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') return reject(new Error('Could not allocate file preview test port'));
    probe.close(error => error ? reject(error) : resolvePort(address.port));
  });
});
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-webui-preview-'));
mkdirSync(join(fixtureRoot, 'codex-home'));
writeFileSync(join(fixtureRoot, 'codex'), `#!${process.execPath}
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  const result = message.method === 'initialize' ? {codexHome:${JSON.stringify(join(fixtureRoot, 'codex-home'))}} : {data:[],account:null,config:{},active:false,turn:null};
  process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
});
`, { mode: 0o700 });
const fixture = join(fixtureRoot, "agent's result.txt");
const body = 'previewed from the Codex conversation\n<script>window.__fileXss=1</script>\n';
writeFileSync(fixture, body);
writeFileSync(join(fixtureRoot, 'source.ts'), Array.from({ length: 100 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n'));
writeFileSync(join(fixtureRoot, 'notes.md'), '# Preview title\n\n**Formatted text**\n\n<script>window.__fileXss=1</script>');
writeFileSync(join(fixtureRoot, 'archive.bin'), Buffer.from([0, 1, 2, 255]));
writeFileSync(join(fixtureRoot, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
// A valid single-page PDF for the browser's built-in viewer.
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>',
  '<< /Length 0 >>\nstream\n\nendstream',
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(fixtureRoot, 'report.pdf'), pdf);
const server = Bun.spawn(['bun', 'run', 'server.ts'], {
  cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(fixtureRoot, 'codex-home'), CODEX_WEBUI_APP_SERVER_MODE: 'isolated', PATH: `${fixtureRoot}:${process.env.PATH}`, CODEX_WEBUI_AUTH_STORE: join(fixtureRoot, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '' },
  stdout: 'ignore', stderr: 'pipe',
});
let browser;

try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt === 79) { server.kill(); await server.exited; throw new Error(`File preview test server did not become ready: ${await new Response(server.stderr).text()}`); }
    await Bun.sleep(100);
  }
  const direct = await fetch(`${base}/api/files/download?path=${encodeURIComponent(fixture)}&cwd=${encodeURIComponent(fixtureRoot)}`);
  assert.ok(direct.ok);
  assert.equal(await direct.text(), body);
  assert.ok(direct.headers.get('content-disposition')?.includes("filename*=UTF-8''agent%27s%20result.txt"));
  assert.equal(direct.headers.get('cache-control'), 'no-store');
  assert.equal(direct.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/api/files/download?path=${encodeURIComponent('/etc/hosts')}`)).status, 404);

  browser = await chromium.launch({ ...launchOptions(), channel: 'chromium' });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1000, height: 720 } });
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  const errors = [], downloads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', download => downloads.push(download));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__codexWebuiDebug);
  await page.evaluate(({ fixture, fixtureRoot }) => {
    const api = globalThis.__codexWebuiDebug;
    api.state.active = { id: 'preview-thread', cwd: fixtureRoot, source: 'local' };
    document.querySelector('#conversation').replaceChildren();
    api.notify('item/completed', { turnId: 'preview-turn', item: {
      id: 'preview-answer', type: 'agentMessage', phase: 'final_answer',
      text: `The result is ready. :codex-file-citation{path="${fixture}" purpose="output" artifact_kind="text"}\n\n[source](./source.ts:70-72) [notes](./notes.md) [binary](./archive.bin) [large](./large.txt) [missing](./missing.txt) [PDF](./report.pdf) [blocked](/etc/hosts)`,
    } });
    // The Files panel follows the active project until the relative citation check below.
  }, { fixture, fixtureRoot });
  const links = page.locator('[data-local-conversation-final-assistant] a[data-file-reference]');
  assert.equal(await links.count(), 8);
  const attributes = await links.first().evaluate(node => ({ href: node.getAttribute('href'), download: node.getAttribute('download'), path: node.dataset.fileReference }));
  assert.deepEqual(attributes, { href: '#file-reference', download: null, path: fixture });
  const ready = () => page.waitForFunction(() => document.querySelector('#filePreview').open && document.querySelector('#filePreviewContent').getAttribute('aria-busy') === 'false');
  await page.click('#toggleFilesPanel');
  await page.waitForFunction(() => document.querySelectorAll('.files-tree-row').length > 0);
  assert.ok(await page.locator('.files-tree-row[data-path="source.ts"]').count());
  assert.equal(await page.locator('.files-tree-row[data-path="large.txt"] .files-tree-button').isDisabled(), true);
  await page.fill('#filesSearch', 'source.ts');
  await page.waitForFunction(() => document.querySelectorAll('.files-tree-row[data-path="source.ts"]').length === 1);
  await page.click('#filesSearchClear');
  await page.locator('.files-tree-row[data-path="source.ts"] .files-tree-button').click();
  await ready();
  assert.equal(await page.locator('.cm-content').getAttribute('contenteditable'), 'false');
  assert.equal(await page.locator('.cm-content').getAttribute('aria-readonly'), 'true');
  await page.click('#closeFilePreview');
  await page.evaluate(() => { globalThis.__codexWebuiDebug.state.active.cwd = '/'; });
  const close = () => page.click('#closeFilePreview');
  await links.first().click();
  await ready();
  assert.equal(await page.locator('#filePreviewTitle').textContent(), "agent's result.txt");
  assert.equal(await page.locator('.cm-line').allTextContents().then(lines => lines.slice(0, 2).join('\n') + '\n'), body);
  assert.equal(await page.evaluate(() => window.__fileXss || 0), 0);
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(downloads.length, 0);

  // The dedicated download action still works, but opening a file never downloads it.
  const downloadPromise = page.waitForEvent('download');
  await page.click('#filePreviewDownload');
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "agent's result.txt");
  assert.equal(readFileSync(await download.path(), 'utf8'), body);
  await page.keyboard.press('Escape');
  assert.equal(await links.first().evaluate(node => document.activeElement === node), true);

  await links.nth(1).click();
  await ready();
  assert.equal(await page.locator('.cm-file-reference-line').count(), 3);
  await page.waitForFunction(() => document.querySelector('.file-preview-editor .cm-scroller').scrollTop >= 0);
  await close();

  await links.nth(2).click();
  await ready();
  assert.equal(await page.locator('.file-preview-markdown h1').textContent(), 'Preview title');
  assert.equal(await page.locator('.file-preview-markdown strong').textContent(), 'Formatted text');
  assert.equal(await page.locator('.file-preview-markdown script').count(), 0);
  assert.equal(await page.evaluate(() => window.__fileXss || 0), 0);
  await page.click('[data-file-view="source"]');
  assert.ok(await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n').includes('# Preview title')));
  await close();

  for (const [index, message] of [[3, 'Preview is not available for this file type.'], [4, 'This file is too large to preview.'], [5, 'File unavailable'], [7, 'File unavailable']]) {
    await links.nth(index).click();
    await ready();
    assert.equal(await page.locator('.file-preview-status').textContent(), message);
    await close();
  }

  await links.nth(6).click();
  await ready();
  assert.ok((await page.locator('.file-preview-pdf').getAttribute('src')).startsWith('blob:'));
  await page.waitForTimeout(300);
  assert.equal(downloads.length, 1);
  await close();

  await page.evaluate(() => Object.defineProperty(navigator, 'pdfViewerEnabled', { value: false, configurable: true }));
  await links.nth(6).click();
  await ready();
  assert.equal(await page.locator('.file-preview-status').textContent(), 'PDF preview is not available in this browser.');
  assert.equal(downloads.length, 1);
  await close();
  await page.evaluate(() => { delete navigator.pdfViewerEnabled; });

  // A closed or superseded request must not overwrite a new preview.
  let releaseResponse;
  const pending = new Promise(resolve => { releaseResponse = resolve; });
  await page.route('**/api/files/download?**', async route => {
    if (new URL(route.request().url()).searchParams.get('path') === './source.ts') {
      await pending;
      try { await route.fulfill({ body: 'stale source' }); } catch {}
    } else await route.continue();
  });
  await links.nth(1).click();
  await close();
  await links.first().click();
  await ready();
  releaseResponse();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#filePreviewTitle').textContent(), "agent's result.txt");
  assert.ok(await page.locator('.cm-line').allTextContents().then(lines => lines.join('\n').includes('previewed from')));
  await close();

  await page.setViewportSize({ width: 390, height: 844 });
  await links.first().click();
  await ready();
  const mobile = await page.locator('#filePreview').evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
  assert.ok(mobile.left >= 0 && mobile.right <= mobile.width && mobile.scrollWidth <= mobile.width);
  await page.screenshot({ path: '/tmp/codex-webui-file-preview-mobile.png' });
  await close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ preview: 'ok', lineSelection: 'ok', markdown: 'ok', pdf: 'ok', errorsAndLimits: 'ok', staleRequests: 'ok', explicitDownload: 'ok', mobile }, null, 2));
} finally {
  await browser?.close();
  server.kill();
  await server.exited;
  rmSync(fixtureRoot, { recursive: true, force: true });
}
