import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { root, launchOptions } from './browser-runtime.mjs';

// Isolated browser test: no account credentials or inference calls needed.
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/vendor/katex/katex.min.css') return new Response(Bun.file(join(root, 'node_modules/katex/dist/katex.min.css')));
  if (pathname === '/vendor/xterm/xterm.css') return new Response(Bun.file(join(root, 'node_modules/@xterm/xterm/css/xterm.css')));
  return new Response(Bun.file(join(root, 'public', pathname === '/' || pathname.startsWith('/settings/') ? 'index.html' : pathname.slice(1))));
} });
const browser = await chromium.launch(launchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'zh-CN'); });
  await page.clock.install();
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const data = path === '/api/auth/status' ? { authenticated: true }
      : path === '/api/config' ? { home: '/tmp', defaultCwd: '/tmp' }
      : path === '/api/account' ? { type: 'chatgpt', displayName: 'Test Account', initials: 'T', planType: 'plus' } : {};
    return route.fulfill({ json: data });
  });
  let socket, failure = false, defer = false, empty = false, pending, usageReads = 0;
  const limits = percent => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 72, windowDurationMins: 10080, resetsAt: 1800500000 } } });
  await page.routeWebSocket('**/ws', ws => {
    socket = ws;
    ws.send(JSON.stringify({ type: 'bridge/status', status: 'connected' }));
    ws.onMessage(raw => {
      const request = JSON.parse(raw);
      if (request.type !== 'rpc') return;
      if (request.method === 'account/rateLimits/read') {
        usageReads++;
        if (defer) { pending = request; return; }
        ws.send(JSON.stringify(failure ? { type: 'rpc/error', id: request.id, error: 'unavailable' } : { type: 'rpc/result', id: request.id, result: empty ? {} : limits(25) }));
      } else ws.send(JSON.stringify({ type: 'rpc/result', id: request.id, result: { data: [] } }));
    });
  });
  await page.goto(`http://127.0.0.1:${server.port}/settings/usage`);
  await page.waitForFunction(() => document.querySelector('#usageWindows')?.textContent.includes('25% 已用'));
  assert.equal(await page.locator('#usageWindows progress').count(), 2);
  assert.equal(await page.locator('[data-settings-page="usage"]').count(), 0);
  assert.ok(await page.locator('#summaryPanel #usageWindows').isVisible());
  assert.equal(await page.locator('.usage-box #refreshUsage').count(), 1);
  assert.equal(await page.locator('.usage-box .usage-card').count(), 2);
  assert.equal(await page.locator('.usage-card').first().evaluate(card => getComputedStyle(card).borderTopWidth), '0px');
  assert.equal(await page.locator('#settingsDialog').evaluate(dialog=>dialog.open), false);
  socket.send(JSON.stringify({ type: 'codex/notification', payload: { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: limits(25).rateLimits.secondary } } } }));
  await page.waitForFunction(() => document.querySelectorAll('#usageWindows .usage-card').length === 1);
  assert.doesNotMatch(await page.locator('#usageWindows').textContent(), /5 小时额度/);
  assert.match(await page.locator('#usageWindows').textContent(), /每周额度/);
  socket.send(JSON.stringify({ type: 'codex/notification', payload: { method: 'account/rateLimits/updated', params: limits(40) } }));
  await page.waitForFunction(() => document.querySelector('#usageWindows').textContent.includes('40% 已用'));
  failure = true;
  await page.click('#refreshUsage');
  await page.waitForFunction(() => document.querySelector('#usageStatus').textContent.includes('无法加载用量'));
  assert.match(await page.locator('#usageWindows').textContent(), /40% 已用/);
  failure = false;
  defer = true;
  await page.click('#refreshUsage');
  await page.waitForFunction(() => document.querySelector('#refreshUsage').disabled);
  socket.send(JSON.stringify({ type: 'codex/notification', payload: { method: 'account/rateLimits/updated', params: limits(55) } }));
  await page.waitForFunction(() => document.querySelector('#usageWindows').textContent.includes('55% 已用'));
  assert.ok(pending);
  socket.send(JSON.stringify({ type: 'rpc/result', id: pending.id, result: limits(25) }));
  await page.waitForTimeout(100);
  assert.match(await page.locator('#usageWindows').textContent(), /55% 已用/);
  defer = false;
  await page.evaluate(() => globalThis.__codexWebuiI18n.setPreference('en'));
  await page.waitForFunction(() => document.querySelector('#usageWindows').textContent.includes('5-hour limit'));
  const beforePoll = usageReads;
  await page.clock.runFor(60001);
  await page.waitForFunction(() => !document.querySelector('#refreshUsage').disabled);
  assert.ok(usageReads > beforePoll);
  empty = true;
  await page.click('#refreshUsage');
  await page.waitForFunction(() => document.querySelector('#usageStatus').textContent.includes('No Codex quota data'));
  assert.equal(await page.locator('#usageWindows progress').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.runFor(100);
  await page.waitForFunction(() => !document.querySelector('#summaryPanel').hidden);
  assert.ok(await page.locator('#usageWindows').isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#summaryPanel').hidden);
  const beforeHidden = usageReads;
  await page.clock.runFor(60001);
  assert.equal(usageReads, beforeHidden);
  await page.evaluate(() => globalThis.__codexWebuiDebug.openSettings('usage'));
  socket.send(JSON.stringify({ type: 'bridge/status', status: 'disconnected' }));
  await page.waitForFunction(() => document.querySelector('#usageStatus').textContent.includes('Connect to Codex'));
  assert.equal(await page.locator('#usageWindows progress').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`Usage browser checks passed (${usageReads} quota reads).`);
} finally {
  await browser.close();
  server.stop(true);
}
