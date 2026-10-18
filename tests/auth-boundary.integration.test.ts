import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { createStoredPassword } from '../server-security.js';
import { saveStoredPassword } from '../password-store.ts';

const root = new URL('..', import.meta.url).pathname;
async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}
async function rejectedUpgrade(url: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Upgrade timed out')); }, 3000);
    socket.on('unexpected-response', (_req, response) => {
      clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode!);
    });
    socket.on('open', () => { clearTimeout(timer); socket.close(); reject(new Error('Unauthenticated upgrade accepted')); });
    socket.on('error', () => {});
  });
}

describe('authentication deployment boundary', () => {
  test('refuses uninitialized external listeners and remote password setup', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'webui-startup-auth-'));
    try {
      for (const args of [[], ['--setup-password']]) {
        const child = Bun.spawn(['bun', 'run', 'server.ts', ...args], {
          cwd: root, env: { ...process.env, HOST: '0.0.0.0', CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', CODEX_WEBUI_AUTH_STORE: join(temp, 'auth.json') },
          stdout: 'pipe', stderr: 'pipe',
        });
        const error = await new Response(child.stderr).text();
        expect(await child.exited).not.toBe(0);
        expect(error).toContain(args.length ? 'Password initialization must listen on localhost' : 'Authentication must be configured');
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test('requires localhost HTTP, SSE and both WebSocket bridges to authenticate in every credential mode', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'webui-auth-boundary-'));
    try {
      const bin = join(temp, 'bin'); mkdirSync(bin);
      // Never start the developer’s real Codex process or use their account in this test.
      writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\nprocess.stdin.resume();\n', { mode: 0o700 });
      const password = 'test-only-password-123';
      const store = join(temp, 'auth.json');
      saveStoredPassword(store, createStoredPassword(password));
      for (const mode of ['password', 'token', 'managed']) {
        const port = await freePort();
        const child = Bun.spawn(['bun', 'run', 'server.ts'], {
          cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: temp, CODEX_HOME: temp, HOST: '127.0.0.1', PORT: String(port), CODEX_WEBUI_PROJECTLESS: 'false', CODEX_WEBUI_CWD: root, CODEX_WEBUI_AUTH_STORE: store, CODEX_WEBUI_PASSWORD: mode === 'password' ? password : '', CODEX_WEBUI_ACCESS_TOKEN: mode === 'token' ? password : '' },
          stdout: 'ignore', stderr: 'ignore',
        });
        const base = `http://127.0.0.1:${port}`;
        try {
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            try { if ((await fetch(`${base}/api/auth/status`)).ok) { ready = true; break; } } catch {}
            if (child.exitCode !== null) throw new Error(`Server exited: ${child.exitCode}`);
            await Bun.sleep(30);
          }
          expect(ready).toBe(true);
          expect((await fetch(`${base}/api/auth/status`).then(res => res.json())).authenticated).toBe(false);
          for (const path of ['/api/health', '/api/events', '/api/rpc', '/app.bundle.js']) {
            expect((await fetch(`${base}${path}`)).status).toBe(401);
          }
          expect(await rejectedUpgrade(`ws://127.0.0.1:${port}/ws`)).toBe(401);
          expect(await rejectedUpgrade(`ws://127.0.0.1:${port}/terminal`)).toBe(401);
          const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
          expect(login.status).toBe(200);
          const cookie = login.headers.get('set-cookie')!.split(';')[0];
          expect((await fetch(`${base}/api/health`, { headers: { cookie } })).status).toBe(200);
          const events = await fetch(`${base}/api/events`, { headers: { cookie } });
          expect(events.status).toBe(200); await events.body?.cancel();
          await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
            ws.once('open', () => { ws.close(); resolve(); }); ws.once('error', reject);
          });
        } finally {
          child.kill('SIGTERM'); await child.exited;
        }
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 20000);
});
