import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { artifact, launchOptions } from './browser-runtime.mjs';
import { createProjectVisibilityFixture } from './project-visibility-fixture.mjs';

const fixture = await createProjectVisibilityFixture();
let browser;
let stage = 'initial load';
const errors = [];
const project = (page, path = fixture.alpha) => page.locator(`.sidebar-project-group[data-project=${JSON.stringify(path)}]`);
async function hide(page) {
  await project(page).locator('.sidebar-project-options').click();
  await page.getByRole('menuitem', { name: 'Hide project', exact: true }).click();
  await project(page).waitFor({ state: 'detached' });
}
async function togglePin(page, path = fixture.alpha) {
  await project(page, path).locator('.sidebar-project-options').click();
  await page.locator('.sidebar-project-menu button').nth(1).click();
}
async function ready(page) {
  await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.modelLoadStatus === 'ready');
}
try {
  browser = await chromium.launch(launchOptions());
  const contexts = await Promise.all([1, 2].map(() => browser.newContext({ viewport: { width: 1018, height: 760 } })));
  for (const context of contexts) {
    context.setDefaultTimeout(10_000);
    const login = await context.request.post(`${fixture.base}/api/auth/login`, { data: { password: 'visibility-test' } });
    assert.equal(login.ok(), true);
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  }
  const [page, second] = await Promise.all(contexts.map(context => context.newPage()));
  for (const tab of [page, second]) tab.on('pageerror', error => errors.push(error.message));
  await Promise.all([page, second].map(tab => tab.goto(fixture.base, { waitUntil: 'networkidle' })));
  await Promise.all([page, second].map(ready));
  await project(page).waitFor(); await project(second).waitFor();
  stage = 'hide and undo';
  assert.equal(await page.locator('[data-project="__tasks__"] .sidebar-project-options').count(), 0);
  await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('old-alpha'));
  await togglePin(page);
  const options = project(page).locator('.sidebar-project-options');
  await options.click(); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await options.evaluate(node => node === document.activeElement), true);
  await hide(page); await project(second).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => globalThis.__codexWebuiDebug.state.active.id), 'old-alpha');
  assert.equal(await page.locator('#threadTitle').textContent(), 'Old alpha session');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await project(page).waitFor(); await project(second).waitFor();
  assert.equal(await project(page).getAttribute('data-pinned'), 'true');
  await hide(page); await project(second).waitFor({ state: 'detached' });
  stage = 'old session and reload';
  // Continuing an existing session, activity notifications and searches cannot unhide it.
  await page.locator('#prompt').fill('Follow up on old session'); await page.locator('#prompt').press('Enter');
  await page.locator('#sidebarSearchButton').click(); await page.locator('#threadSearch').fill('alpha');
  assert.equal(await project(page).count(), 0);
  await page.locator('#sidebarSearchClose').click();
  await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  assert.equal(await project(page).count(), 0);
  await project(page, fixture.beta).waitFor();
  stage = 'folder selection';
  // Choosing a folder prepares a task but does not create a native session.
  await page.locator('#newTask').click(); await page.locator('#composerProjectButton').click();
  await page.locator('#folderPathInput').fill(fixture.alpha); await page.locator('#folderGo').click();
  await page.waitForFunction(path => document.querySelector('#folderSelection').textContent === path, fixture.alpha);
  await page.locator('#folderConfirm').click();
  assert.equal(await project(page).count(), 0);
  // A failed creation keeps the project hidden and the user's draft available.
  stage = 'failed creation';
  await page.evaluate(() => globalThis.__codexWebuiDebug.state.selectedModel = 'fail');
  await page.locator('#prompt').fill('New session'); await page.locator('#prompt').press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.persistent-error-body p')].some(node=>node.textContent.includes('Fixture creation failed')));
  assert.equal(await project(page).count(), 0);
  await page.evaluate(() => globalThis.__codexWebuiDebug.state.selectedModel = 'gpt-fixture');
  stage = 'successful creation';
  await page.locator('#prompt').press('Enter');
  await project(page).waitFor(); await project(second).waitFor();
  assert.equal(await project(page).locator('.sidebar-project-row').getAttribute('aria-expanded'), 'true');
  assert.equal(await project(page).locator('.thread-item[data-id="old-alpha"]').count(), 1);
  assert.equal(await project(page).locator('.thread-item[data-id^="new-"]').count(), 1);
  assert.equal(await project(page).getAttribute('data-pinned'), 'true');
  // Both queue creation and the HTTP/SSE fallback share the native creation hook.
  stage = 'queue and SSE';
  await hide(page);
  await page.evaluate(() => { const api = globalThis.__codexWebuiDebug; api.state.ws?.close(); });
  await page.waitForFunction(() => globalThis.__codexWebuiDebug.state.transport === 'sse');
  await page.locator('#newTask').click(); await page.locator('#prompt').fill('Queued new session'); await page.locator('#queueButton').click();
  await project(page).waitFor(); await project(second).waitFor();
  await page.locator('.message-queue-row[data-status="queued"]').waitFor();
  assert.equal(await project(page).locator('.thread-item[data-id^="new-"]').count(), 2);
  // A late response must not overwrite a newer broadcast received while it was delayed.
  stage = 'stale response';
  let release;
  await page.route('**/api/projects/visibility', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    release = () => route.fulfill({ response });
  });
  await project(page).locator('.sidebar-project-options').click();
  await page.getByRole('menuitem', { name: 'Hide project', exact: true }).click();
  await project(page).waitFor({ state: 'detached' });
  await fixture.visibility({ project: fixture.alpha, hidden: false });
  await project(page).waitFor();
  while (!release) await Bun.sleep(10);
  await release(); await page.unroute('**/api/projects/visibility');
  assert.equal(await project(page).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  // The fixed menu remains inside a narrow viewport and provides localized labels.
  stage = 'mobile';
  await page.setViewportSize({ width: 390, height: 760 });
  await page.waitForFunction(() => document.querySelector('#toggleSidebar').getAttribute('aria-expanded') === 'false');
  await page.evaluate(() => { globalThis.__codexWebuiI18n.setPreference('zh-CN'); globalThis.__codexWebuiDebug.setSidebarOpen(true); });
  await project(page).locator('.sidebar-project-options').click();
  const menu = page.getByRole('menu');
  const bounds = await menu.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['新建会话', '取消置顶', '隐藏项目']);
  await page.screenshot({ path: artifact('project-visibility-menu-mobile.png') });
  await menu.getByRole('menuitem', { name: '新建会话', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.__codexWebuiDebug.state.active), null);
  assert.equal(await page.locator('#threadTitle').textContent(), '新任务');
  assert.equal(await page.locator('#projectName').textContent(), 'alpha');
  assert.deepEqual(errors, []);
  console.log('Project hiding, undo, refresh, old/new sessions, queue, WS/SSE sync, stale replies and mobile menu passed.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  console.error('Project visibility browser failure:', stage, errors, await page?.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, folder: document.querySelector('#folderSelection')?.textContent, status: globalThis.__codexWebuiDebug?.state.modelLoadStatus, transport: globalThis.__codexWebuiDebug?.state.transport, active: globalThis.__codexWebuiDebug?.state.active?.id })));
  throw error;
} finally {
  await browser?.close(); await fixture.dispose();
}
