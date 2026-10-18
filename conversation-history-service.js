import { createHash, randomBytes } from 'node:crypto';

// Keep full history on the host; the browser receives only its visible range and changes.
export function createConversationHistory({ readThread, fingerprint = () => null, maxThreads = 8 }) {
  const cache = new Map(), inFlight = new Map(), generations = new Map();
  let sequence = 0;
  const epoch = randomBytes(6).toString('hex');
  function snapshot(thread) {
    const records = [], turns = (thread.turns || []).map((turn, turnOrder) => {
      const { items = [], ...metadata } = turn;
      for (let itemOrder = 0; itemOrder < items.length; itemOrder++) {
        const item = items[itemOrder], key = `${turn.id}:${item.id}`;
        records.push({ key, turnOrder, itemOrder, item, hash: createHash('sha256').update(JSON.stringify(item)).digest('hex') });
      }
      return { ...metadata, historyOrder: turnOrder };
    });
    const { turns: omitted, ...metadata } = thread;
    return { thread: metadata, turns, records, byKey: new Map(records.map((record, index) => [record.key, { ...record, index }])), revision: `${epoch}-${++sequence}` };
  }
  async function current(id) {
    const stored = cache.get(id), signature = fingerprint(id);
    if (stored && !stored.dirty && signature !== null && signature === stored.signature) {
      cache.delete(id); cache.set(id, stored); return stored;
    }
    if (inFlight.has(id)) return inFlight.get(id);
    const work = (async () => {
      const generation = generations.get(id) || 0;
      const thread = await readThread(id), next = snapshot(thread);
      const entry = { latest: next, versions: [...(stored?.versions || []), next].slice(-3), signature: fingerprint(id), dirty: false };
      // A notification received while reading must trigger another refresh.
      entry.dirty = generation !== (generations.get(id) || 0) || (signature !== null && signature !== entry.signature);
      cache.delete(id); cache.set(id, entry);
      while (cache.size > maxThreads) { const oldest=cache.keys().next().value;cache.delete(oldest);generations.delete(oldest); }
      return entry;
    })();
    inFlight.set(id, work);
    try { return await work; } finally { inFlight.delete(id); }
  }
  return {
    invalidate(id) { if(!cache.has(id)&&!inFlight.has(id))return;generations.set(id,(generations.get(id)||0)+1); const entry = cache.get(id); if (entry) entry.dirty = true; },
    clear() { cache.clear(); generations.clear(); },
    async read({ threadId, revision, oldestItemId, cursor, limit = 100 } = {}) {
      if (typeof threadId !== 'string' || !threadId) throw new Error('Invalid thread id');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('History limit must be between 1 and 100');
      const entry = await current(threadId), latest = entry.latest, total = latest.records.length;
      const baseline = entry.versions.find(version => version.revision === revision);
      let start, end = total, mode = 'snapshot', removedItemIds = [];
      if (cursor) {
        const anchor = latest.byKey.get(cursor);
        if (!anchor) throw new Error('History cursor expired; refresh the conversation');
        end = anchor.index; start = Math.max(0, end - limit); mode = 'page';
      } else if (revision && oldestItemId && latest.byKey.has(oldestItemId)) {
        start = latest.byKey.get(oldestItemId).index; mode = 'delta';
        if (baseline) removedItemIds = baseline.records.filter((record, index) => index >= (baseline.byKey.get(oldestItemId)?.index ?? total) && !latest.byKey.has(record.key)).map(record => record.key);
      } else { start = Math.max(0, total - limit); }
      if(mode==='delta'&&!baseline){mode='snapshot';start=Math.max(0,total-limit)}
      let records = latest.records.slice(start, end).filter(record => mode !== 'delta' || !baseline || baseline.byKey.get(record.key)?.hash !== record.hash || baseline.byKey.get(record.key)?.itemOrder !== record.itemOrder);
      if(records.length>limit){mode='snapshot';start=Math.max(0,total-limit);records=latest.records.slice(start);removedItemIds=[]}
      const grouped = new Map();
      for (const record of records) {
        const turn = grouped.get(record.turnOrder) || { ...latest.turns[record.turnOrder], items: [] };
        turn.items.push({ ...record.item, historyOrder: record.itemOrder }); grouped.set(record.turnOrder, turn);
      }
      // Empty deltas still carry turn status transitions.
      if (mode === 'delta') {
        const loadedTurns=new Set(latest.records.slice(start).map(record=>record.turnOrder));
        for (const turn of latest.turns) if (loadedTurns.has(turn.historyOrder)&&!grouped.has(turn.historyOrder)&&JSON.stringify(turn)!==JSON.stringify(baseline?.turns.find(old=>old.id===turn.id))) grouped.set(turn.historyOrder, { ...turn, items: [] });
      }
      return { thread: latest.thread, history: { mode, revision: latest.revision, turns: [...grouped.values()].sort((a,b)=>a.historyOrder-b.historyOrder), removedItemIds, nextCursor: start > 0 ? latest.records[start]?.key : null, oldestItemId: latest.records[start]?.key || null, totalItems: total } };
    },
  };
}
