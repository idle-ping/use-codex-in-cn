import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readComposerHistory } from '../composer-history-service.js';

test('CLI history handles absent files, malformed rows, limits and truncated tails', async () => {
  const root=mkdtempSync(join(tmpdir(),'composer-history-'));
  try {
    expect(await readComposerHistory(root)).toEqual([]);
    const row=text=>JSON.stringify({session_id:'thread',text})+'\n';
    writeFileSync(join(root,'history.jsonl'),row('old')+'invalid\n'+row('多行\n消息')+row('new')+'{"text":');
    expect(await readComposerHistory(root,{limit:2})).toEqual([{text:'多行\n消息',sessionId:'thread'},{text:'new',sessionId:'thread'}]);
    expect(await readComposerHistory(root,{maxBytes:Buffer.byteLength(row('new'))+10})).toEqual([{text:'new',sessionId:'thread'}]);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
