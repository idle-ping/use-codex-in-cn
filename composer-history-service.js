import { open } from 'node:fs/promises';
import { join } from 'node:path';

// Read a bounded tail so a large CLI history cannot block the browser or server.
export async function readComposerHistory(codexHome, { maxBytes = 4 * 1024 * 1024, limit = 1000 } = {}) {
  let file;
  try {
    file = await open(join(codexHome, 'history.jsonl'), 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - maxBytes), buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await file.read(buffer, read, buffer.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    if (start) lines.shift(); // The first line may have been cut mid-record.
    const entries = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry.text === 'string' && entry.text) entries.push({ text: entry.text, ...(entry.session_id ? { sessionId: entry.session_id } : {}), ...(Number.isFinite(Number(entry.ts)) ? { timestamp: Number(entry.ts) } : {}) });
      } catch { /* A malformed or still-being-written record is not a prompt. */ }
    }
    return entries.slice(-limit);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally {
    await file?.close();
  }
}
