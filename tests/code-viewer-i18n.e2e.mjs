import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { root, launchOptions } from './browser-runtime.mjs';

// A 20KB Python file contains identifiers that also occur in the UI dictionary.
// The DOM translator must never fight CodeMirror over its highlighted nodes.
const text = 'class Error(Exception):\n    pass\n\nclass Files:\n    def Download(self):\n        return Error\n\n'.repeat(225);
const directory = await mkdtemp(join(tmpdir(), 'code-viewer-i18n-'));
let server, browser;
try {
  const entry = join(directory, 'entry.js');
  await writeFile(entry, `
import {createFilePreview} from ${JSON.stringify(`${root}/public/file-preview.js`)};
import {createI18n,createDomI18n} from ${JSON.stringify(`${root}/public/i18n.js`)};
const locale = new URL(location.href).searchParams.get('locale');
const i18n = createI18n({storage:{getItem:()=>locale},languages:[]});
const binding = createDomI18n(i18n);
const preview = createFilePreview({t:value=>i18n.t(value)});
window.api = {preview,i18n};
window.ready = preview.open({path:'example.py'}).then(()=>new Promise(resolve=>setTimeout(resolve,500)));
`);
  const build = await Bun.build({ entrypoints: [entry], target: 'browser' });
  assert.ok(build.success, build.logs.join('\n'));
  const bundle = await build.outputs[0].text();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/bundle.js') return new Response(bundle, {headers:{'content-type':'text/javascript'}});
    if (path === '/file-preview.css') return new Response(Bun.file(`${root}/public/file-preview.css`));
    if (path === '/api/files/download') return new Response(text);
    return new Response('<!doctype html><button id="ui">Settings</button><script type="module" src="/bundle.js"></script>', {headers:{'content-type':'text/html'}});
  }});
  browser = await chromium.launch(launchOptions());
  for (const locale of ['en', 'zh-CN']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let timer;
    try {
      await Promise.race([
        (async () => {
          await page.goto(`http://127.0.0.1:${server.port}?locale=${locale}`, {waitUntil:'domcontentloaded'});
          await page.evaluate(() => window.ready);
          assert.equal(await page.locator('#ui').textContent(), locale === 'zh-CN' ? '设置' : 'Settings');
          assert.equal(await page.locator('.cm-content').getAttribute('contenteditable'), 'false');
          assert.ok(await page.locator('.cm-line span[class]').count(), '20KB Python should be highlighted');
          assert.ok(await page.locator('.cm-line').allTextContents().then(lines => lines.some(line => line.includes('class Error')) && lines.some(line => line.includes('class Files')) && lines.some(line => line.includes('Download'))));
          await page.evaluate(() => { window.api.i18n.setPreference('en'); window.api.i18n.setPreference('zh-CN'); });
          assert.ok(await page.locator('.cm-line').allTextContents().then(lines => lines.some(line => line.includes('class Error(Exception)'))));
          await page.locator('#closeFilePreview').click();
          assert.equal(await page.locator('#filePreview').evaluate(node => node.open), false);
          assert.deepEqual(errors, []);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Editor froze in ${locale}`)), 8000); }),
      ]);
    } finally { clearTimeout(timer); await page.close(); }
  }
  console.log(JSON.stringify({pythonBytes:Buffer.byteLength(text),locales:['en','zh-CN'],highlightedSourcePreserved:true,closeResponsive:true}));
} finally { await browser?.close(); server?.stop(true); await rm(directory,{recursive:true,force:true}); }
