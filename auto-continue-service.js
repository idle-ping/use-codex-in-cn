function isCapacityFailure(turn) {
  if (!['failed', 'error'].includes(turn?.status)) return false;
  const error = turn.error || turn.failure;
  const code = error?.codexErrorInfo ?? error?.codex_error_info;
  if (code === 'serverOverloaded' || code === 'server_overloaded') return true;
  const message = typeof error === 'string' ? error : error?.message || '';
  return /(?:model|server).*?(?:at capacity|overloaded)|(?:at capacity|overloaded).*?(?:model|server)/i.test(message);
}

// Recovery follows live terminal events, never errors found in history or a
// nonterminal error notification. Recheck the latest turn before sending input.
export function createAutoContinueRecovery(request, onError = () => {}, {
  schedule = setTimeout, cancel = clearTimeout, maxAttempts = 3,
} = {}) {
  const threads = new Map();
  const stateFor = id => {
    let state = threads.get(id);
    if (!state) {
      state = { latestTurnId: null, active: false, attempts: 0, retry: null, completed: new Set(), automaticTurns: new Set() };
      threads.set(id, state);
    }
    return state;
  };
  const clear = state => {
    if (state.retry) cancel(state.retry.timer);
    state.retry = null;
  };
  const recover = (threadId, state, turn) => {
    if (state.retry || state.attempts >= maxAttempts) return;
    const retry = { turnId: turn.id, timer: null, sending: false };
    state.retry = retry;
    retry.timer = schedule(async () => {
      try {
        const { thread } = await request('thread/read', { threadId, includeTurns: true });
        if (state.retry !== retry) return;
        const latest = thread?.turns?.at(-1);
        if (state.active || thread?.status?.type === 'active'
          || thread?.turns?.some(item => item.status === 'inProgress')
          || latest?.id !== retry.turnId || !isCapacityFailure(latest)) return;
        retry.sending = true;
        state.attempts++;
        const result = await request('turn/start', { threadId, input: [{ type: 'text', text: 'continue' }] });
        const startedId = result?.turn?.id;
        if (startedId && !state.completed.has(startedId)) {
          state.automaticTurns.add(startedId);
          state.latestTurnId = startedId;
          state.active = true;
        }
      } catch (error) {
        onError(error);
      } finally {
        if (state.retry === retry) state.retry = null;
      }
    }, 1500 * 2 ** state.attempts);
  };
  return {
    onNotification(message) {
      const { threadId, turn } = message.params || {};
      if (typeof threadId !== 'string' || !threadId) return;
      if (['thread/closed', 'thread/deleted'].includes(message.method)) {
        const state = threads.get(threadId);
        if (state) clear(state);
        threads.delete(threadId);
        return;
      }
      if (!['turn/started', 'turn/completed'].includes(message.method)
        || typeof turn?.id !== 'string' || !turn.id) return;
      const state = stateFor(threadId);
      if (message.method === 'turn/started') {
        const automatic = state.automaticTurns.delete(turn.id) || state.retry?.sending === true;
        if (state.completed.has(turn.id) || (state.latestTurnId === turn.id && !automatic)) return;
        clear(state);
        if (!automatic) state.attempts = 0;
        state.latestTurnId = turn.id;
        state.active = true;
        return;
      }
      if (!['completed', 'failed', 'interrupted'].includes(turn.status)
        || state.completed.has(turn.id)) return;
      state.completed.add(turn.id);
      // A terminal event without a matching live start can be historical
      // replay; it is never enough evidence to create a new turn.
      if (state.latestTurnId !== turn.id) return;
      state.latestTurnId = turn.id;
      state.active = false;
      if (turn.status === 'completed') {
        clear(state);
        state.attempts = 0;
      } else if (isCapacityFailure(turn)) recover(threadId, state, turn);
    },
    onExplicitInput(threadId) {
      if (typeof threadId !== 'string' || !threadId) return;
      const state = stateFor(threadId);
      clear(state);
      state.attempts = 0;
    },
  };
}
