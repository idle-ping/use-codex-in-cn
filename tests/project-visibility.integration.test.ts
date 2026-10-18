import { expect, test } from 'bun:test';
import WebSocket from 'ws';
import { createProjectVisibilityFixture, waitFor } from './project-visibility-fixture.mjs';

test('visibility persists across restart, synchronizes WS/SSE, and restores only after successful project session creation', async () => {
  const fixture = await createProjectVisibilityFixture();
  let ws: WebSocket, reader;
  const messages: any[] = [];
  try {
    expect((await fetch(`${fixture.base}/api/projects/visibility`)).status).toBe(401);
    expect((await fetch(`${fixture.base}/api/projects/visibility`, { method: 'DELETE', headers: fixture.headers })).status).toBe(405);
    const invalid = await fetch(`${fixture.base}/api/projects/visibility`, { method: 'POST', headers: { ...fixture.headers, 'content-type': 'application/json' }, body: JSON.stringify({ project: '__tasks__', hidden: true }) });
    expect(invalid.status).toBe(400);
    ws = new WebSocket(fixture.base.replace('http', 'ws') + '/ws', { headers: fixture.headers });
    ws.on('message', raw => messages.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await waitFor(() => messages.find(m => m.type === 'projects/visibility'));
    reader = (await fetch(`${fixture.base}/api/events`, { headers: fixture.headers })).body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    expect(firstChunk).toContain('projects/visibility');
    const hidden = await fixture.visibility({ project: fixture.alpha + '/', hidden: true });
    expect(hidden.hiddenProjects[fixture.alpha]).toBeDefined();
    await waitFor(() => messages.find(m => m.type === 'projects/visibility' && m.revision === hidden.revision));
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain(String(hidden.revision));
    await fixture.rpc('thread/resume', { threadId: 'old-alpha' });
    await fixture.rpc('thread/read', { threadId: 'old-alpha' });
    await fixture.rpc('turn/start', { threadId: 'old-alpha', input: [] });
    await fixture.rpc('thread/list');
    expect(await fixture.visibility()).toEqual(hidden);
    expect((await fixture.rpc('thread/start', { cwd: fixture.alpha, model: 'fail' })).type).toBe('rpc/error');
    expect(await fixture.visibility()).toEqual(hidden);
    await fixture.rpc('thread/start', { cwd: fixture.alpha, webuiProjectless: true });
    expect(await fixture.visibility()).toEqual(hidden);
    // Metadata must be stripped before forwarding to the native app-server.
    const started = await fixture.rpc('thread/start', { cwd: fixture.alpha, webuiProjectless: false });
    expect(started.type).toBe('rpc/result');
    expect(started.projectVisibility.hiddenProjects).toEqual({});
    await waitFor(() => messages.find(m => m.type === 'projects/visibility' && m.revision === started.projectVisibility.revision));
    expect((await fixture.rpc('thread/list')).result.data.some(t => t.id === 'old-alpha')).toBe(true);
    const again = await fixture.visibility({ project: fixture.alpha, hidden: true });
    const staleUndo = await fixture.visibility({ project: fixture.alpha, hidden: false, expectedHiddenAt: hidden.hiddenProjects[fixture.alpha].hiddenAt });
    expect(staleUndo).toEqual(again);
    await reader.cancel(); reader = null; ws.close();
    await fixture.stop(); await fixture.start();
    expect(await fixture.visibility()).toEqual(again);
  } finally {
    await reader?.cancel(); ws?.terminate(); await fixture.dispose();
  }
}, 30_000);
