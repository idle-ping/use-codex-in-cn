import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { artifact, launchOptions } from './browser-runtime.mjs';
import { createProjectVisibilityFixture } from './project-visibility-fixture.mjs';

const fixture = await createProjectVisibilityFixture();
let browser;
try {
  browser = await chromium.launch(launchOptions());
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ ...(mobile ? devices['iPhone 13'] : {}), viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
    context.setDefaultTimeout(10_000);
    await context.request.post(`${fixture.base}/api/auth/login`, { data: { password: 'visibility-test' } });
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    const page = await context.newPage(), decisions = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/codex/respond', route => { decisions.push(route.request().postDataJSON()); return route.fulfill({ json: { type: 'ack' } }); });
    await page.goto(fixture.base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.modelLoadStatus === 'ready');
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('old-alpha'));
    // Use the real approval renderer while recording decisions instead of running a command.
    await page.evaluate(() => { const api = globalThis.__codexWebuiDebug; api.state.ws?.close(); });
    await page.waitForFunction(() => globalThis.__codexWebuiDebug.state.transport === 'sse');
    const request = (id, scoped = 'session') => page.evaluate(({ id, scoped }) => {
      const api = globalThis.__codexWebuiDebug;
      api.request({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'old-alpha', turnId: `approval-${id}`, itemId: `command-${id}`, command: 'echo test', cwd: api.state.config.defaultCwd, availableDecisions: ['accept', 'decline', 'acceptForSession'], ...(scoped === 'similar' ? { proposedExecpolicyAmendment: ['echo'] } : {}) } });
    }, { id, scoped });
    const card = () => page.locator('.approval-card').last();
    const toggle = () => card().locator('.approval-menu-toggle');
    const menu = () => page.locator('.approval-menu.floating-menu');
    const visibleAndUnclipped = async () => {
      const bounds = await menu().boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= (mobile ? 390 : 1280));
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= (mobile ? 844 : 800));
      assert.equal(await menu().getByRole('menuitem').evaluate(item => {
        const r = item.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.approval-scoped') === item;
      }), true);
      assert.equal(await menu().evaluate(node => node.parentElement === document.body), true);
    };
    await request(501);
    await toggle().click(); await visibleAndUnclipped();
    assert.equal(await menu().getByRole('menuitem').textContent(), 'Allow this conversation');
    await page.keyboard.press('Escape');
    assert.equal(await menu().count(), 0);
    assert.equal(await toggle().getAttribute('aria-expanded'), 'false');
    assert.equal(decisions.length, 0);
    await toggle().click(); await page.locator('.topbar').click();
    assert.equal(await menu().count(), 0);
    assert.equal(decisions.length, 0);
    await toggle().click(); await visibleAndUnclipped();
    await menu().getByRole('menuitem').click();
    await page.waitForFunction(() => document.querySelectorAll('.approval-card').length === 0);
    assert.deepEqual(decisions.pop().result, { decision: 'acceptForSession' });
    await request(502, 'similar'); await toggle().click(); await visibleAndUnclipped();
    await page.screenshot({ path: artifact(mobile ? 'approval-menu-mobile.png' : 'approval-menu-desktop.png') });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.approval-card').length === 0);
    assert.deepEqual(decisions.pop().result, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } } });
    await request(503); await toggle().click();
    await page.evaluate(() => globalThis.__codexWebuiDebug.notify('serverRequest/resolved', { requestId: 503 }));
    assert.equal(await menu().count(), 0);
    assert.equal(await page.locator('.approval-card').count(), 0);
    await request(504); await toggle().click();
    await page.evaluate(() => globalThis.__codexWebuiDebug.startNewTask());
    assert.equal(await menu().count(), 0);
    assert.equal(decisions.length, 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Approval menu escapes clipping, stays on screen, closes cleanly and preserves session/similar-command decisions on desktop and mobile.');
} finally { await browser?.close(); await fixture.dispose(); }
