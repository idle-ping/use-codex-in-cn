// Codex pauses its native queue after an interrupted turn. Recover it in the
// bridge so queued messages keep progressing even with no browser connected.
export function createQueueRecovery(request, onError = () => {}) {
  const recovering = new Map();
  return function recoverQueue(threadId) {
    if (!threadId) return Promise.resolve();
    const current = recovering.get(threadId);
    if (current) { current.again = true; return current.promise; }
    const entry = { again: false, promise: null };
    recovering.set(threadId, entry);
    const checkQueue = async () => {
      const { thread } = await request("thread/read", { threadId, includeTurns: true });
      if (!thread || thread.status?.type === "active" || thread.turns?.some(turn => turn.status === "inProgress")) return;
      const queue = await request("thread/queue/list", { threadId, limit: 1 });
      const first = queue.data?.[0];
      if (first) await request("thread/queue/start", { threadId, queuedSubmissionId: first.id });
    };
    entry.promise = (async () => {
      do {
        entry.again = false;
        await checkQueue();
      } while (entry.again);
    })().catch(onError).finally(() => recovering.delete(threadId));
    return entry.promise;
  };
}
