import { describe, expect, test } from 'bun:test';
import { createAutoContinueRecovery } from '../auto-continue-service.js';

const failure = (id: string) => ({ id, status: 'failed', error: {
  message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded',
} });

function fixture() {
  const timers: any[] = [], calls: any[] = [], errors: any[] = [];
  let snapshot: any = { thread: { id: 'cli', status: { type: 'idle' }, turns: [failure('original')] } };
  let read: any = () => snapshot;
  const recovery = createAutoContinueRecovery(async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/read') return read();
    return { turn: { id: `retry-${calls.filter(c => c.method === 'turn/start').length}` } };
  }, error => errors.push(error), {
    schedule: (callback: any, delay: number) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
    cancel: (timer: any) => { timer.cancelled = true; },
  });
  const notify = (method: string, turn: any) => recovery.onNotification({ method, params: { threadId: 'cli', turn } });
  const starts = () => calls.filter(c => c.method === 'turn/start');
  const flush = async () => { const timer = timers.shift(); if (timer && !timer.cancelled) await timer.callback(); };
  return { recovery, timers, calls, errors, notify, starts, flush,
    snapshot: (value: any) => { snapshot = value; }, read: (value: any) => { read = value; } };
}

describe('automatic Continue after terminal capacity failures', () => {
  test('CLI turn errors do not recover until the failed terminal event arrives', async () => {
    const f = fixture();
    f.notify('turn/started', { id: 'original', status: 'inProgress' });
    f.recovery.onNotification({ method: 'error', params: { threadId: 'cli', turnId: 'original', error: failure('original').error } });
    f.notify('turn/completed', { ...failure('original'), status: 'inProgress' });
    expect(f.timers).toHaveLength(0);
    f.notify('turn/completed', failure('original'));
    await f.flush();
    expect(f.calls.map(c => c.method)).toEqual(['thread/read', 'turn/start']);
    expect(f.starts()[0].params).toEqual({ threadId: 'cli', input: [{ type: 'text', text: 'continue' }] });
  });

  test('duplicates of a failed turn schedule only one recovery', async () => {
    const f = fixture();
    f.notify('turn/started', { id: 'original', status: 'inProgress' });
    f.notify('turn/completed', failure('original'));
    f.notify('turn/completed', failure('original'));
    await f.flush();
    f.notify('turn/completed', failure('original'));
    expect(f.starts()).toHaveLength(1);
    expect(f.timers).toHaveLength(0);
  });

  test('a delayed historical failure cannot recover over a newer active turn', async () => {
    const f = fixture();
    f.notify('turn/started', { id: 'new', status: 'inProgress' });
    f.notify('turn/completed', failure('old'));
    await f.flush();
    expect(f.calls).toHaveLength(0);
  });

  test.each([
    { status: { type: 'active' }, turns: [failure('original')] },
    { status: { type: 'idle' }, turns: [failure('original'), { id: 'new', status: 'inProgress' }] },
    { status: { type: 'idle' }, turns: [failure('original'), { id: 'new', status: 'completed' }] },
    { status: { type: 'idle' }, turns: [{ id: 'original', status: 'completed' }] },
    { status: { type: 'idle' }, turns: [{ id: 'original', status: 'failed', error: { message: 'Network failure' } }] },
  ])('fresh backend state must still show the same terminal capacity failure: %j', async thread => {
    const f = fixture();
    f.notify('turn/completed', failure('original'));
    f.snapshot({ thread });
    await f.flush();
    expect(f.starts()).toHaveLength(0);
  });

  test('a new CLI turn cancels recovery while the state read is in flight', async () => {
    const f = fixture();
    let release: any;
    f.read(() => new Promise(resolve => { release = resolve; }));
    f.notify('turn/started', { id: 'original', status: 'inProgress' });
    f.notify('turn/completed', failure('original'));
    const pending = f.flush();
    f.notify('turn/started', { id: 'new', status: 'inProgress' });
    release({ thread: { turns: [failure('original')] } });
    await pending;
    expect(f.starts()).toHaveLength(0);
  });

  test('three consecutive failed retries back off and stop; explicit CLI input resets the budget', async () => {
    const f = fixture();
    let id = 'original';
    for (let attempt = 0; attempt < 3; attempt++) {
      f.snapshot({ thread: { status: { type: 'idle' }, turns: [failure(id)] } });
      f.notify('turn/started', { id, status: 'inProgress' });
      f.notify('turn/completed', failure(id));
      expect(f.timers[0].delay).toBe(1500 * 2 ** attempt);
      await f.flush();
      id = `retry-${attempt + 1}`;
      // RPC acknowledgment can arrive before the started event.
      f.notify('turn/started', { id, status: 'inProgress' });
    }
    f.notify('turn/completed', failure(id));
    expect(f.starts()).toHaveLength(3);
    expect(f.timers).toHaveLength(0);
    f.notify('turn/started', { id: 'user-new', status: 'inProgress' });
    f.snapshot({ thread: { turns: [failure('user-new')] } });
    f.notify('turn/completed', failure('user-new'));
    await f.flush();
    expect(f.starts()).toHaveLength(4);
  });

  test('explicit input cancels a waiting timer', async () => {
    const f = fixture();
    f.notify('turn/started', { id: 'original', status: 'inProgress' });
    f.notify('turn/completed', failure('original'));
    f.recovery.onExplicitInput('cli');
    await f.flush();
    expect(f.calls).toHaveLength(0);
  });

  test('success, user interruption, and invalid reasoning effort never retry', async () => {
    const f = fixture();
    for (const turn of [
      { ...failure('done'), status: 'completed' },
      { ...failure('stop'), status: 'interrupted' },
      { id: 'effort', status: 'failed', error: { message: 'Maximum reasoning strength too high' } },
    ]) f.notify('turn/completed', turn);
    await f.flush();
    expect(f.calls).toHaveLength(0);
  });

  test('an unavailable backend state never produces speculative input', async () => {
    const f = fixture();
    f.read(() => { throw new Error('Disconnected'); });
    f.notify('turn/started', { id: 'original', status: 'inProgress' });
    f.notify('turn/completed', failure('original'));
    await f.flush();
    expect(f.starts()).toHaveLength(0);
    expect(f.errors).toHaveLength(1);
  });
});
