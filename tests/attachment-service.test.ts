import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_MAX_BYTES, saveAttachment } from '../attachment-service.js';
import { attachmentsFromInput, buildComposerInput, composerInputKey, composerTextFromInput } from '../public/composer-attachments.js';
import { createComposerHistory } from '../public/ui-core.js';

const png=readFileSync(new URL('../public/assets/codex-app-icon-128.png',import.meta.url));
const request=(bytes,headers={})=>Object.assign((async function*(){yield bytes})(),{headers});

test('uploads use isolated names and retain validated image bytes and private permissions', async () => {
  const root=mkdtempSync(join(tmpdir(),'webui-upload-'));
  try {
    const first=await saveAttachment(request(png),root,'../../截图.png');
    const second=await saveAttachment(request(png),root,'截图.png');
    expect(first.name).toBe('截图.png');expect(first.kind).toBe('image');
    expect(first.path.startsWith(root+'/')).toBe(true);expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path)).toEqual(png);
    expect(statSync(first.path).mode&0o777).toBe(0o600);
    const file=await saveAttachment(request(Buffer.from('notes')),root,'notes.txt');
    expect(file.kind).toBe('file');expect(file.size).toBe(5);
  } finally {rmSync(root,{recursive:true,force:true})}
});

test('empty, oversized, aborted and disguised image uploads do not leave files', async () => {
  const root=mkdtempSync(join(tmpdir(),'webui-upload-reject-'));
  try {
    await expect(saveAttachment(request(Buffer.alloc(0)),root,'empty.txt')).rejects.toThrow('empty');
    await expect(saveAttachment(request(Buffer.from('invalid')),root,'fake.png')).rejects.toThrow('file type');
    await expect(saveAttachment(request(Buffer.from('small'),{'content-length':ATTACHMENT_MAX_BYTES+1}),root,'large.txt')).rejects.toThrow('25 MiB');
    await expect(saveAttachment(request(Buffer.alloc(ATTACHMENT_MAX_BYTES+1)),root,'large.txt')).rejects.toThrow('25 MiB');
    await expect(saveAttachment(request(png),root,'..')).rejects.toThrow('filename');
    const aborted=(async function*(){yield png;throw new Error('aborted')})();
    await expect(saveAttachment(aborted,root,'aborted.png')).rejects.toThrow('aborted');
    expect(readdirSync(root)).toEqual([]);
  } finally {rmSync(root,{recursive:true,force:true})}
});

test('image-only history and mixed file/image input retain their attachment identity', () => {
  const attachments=[{id:'a',name:'image.png',path:'/uploads/image.png',kind:'image',status:'ready'},{id:'b',name:'notes.txt',path:'/uploads/notes.txt',kind:'file',status:'ready'}];
  const input=buildComposerInput('Review these',attachments);
  expect(input[1]).toEqual({type:'localImage',path:'/uploads/image.png'});
  expect(attachmentsFromInput(input).map(value=>[value.kind,value.path])).toEqual(attachments.map(value=>[value.kind,value.path]));
  expect(composerTextFromInput(input)).toBe('Review these');
  const merged=[{type:'text',text:input.filter(part=>part.type==='text').map(part=>part.text).join('\n')}];
  expect(composerTextFromInput(merged)).toBe('Review these');
  expect(attachmentsFromInput(merged)[0].name).toBe('notes.txt');
  expect(composerInputKey(buildComposerInput('',[attachments[0]]))).not.toBe(composerInputKey(buildComposerInput('',[{...attachments[0],path:'/different.png'}])));
  const history=createComposerHistory();history.record({text:'',attachments:[attachments[0]]});
  const recalled=history.navigate(-1,'',0);expect(recalled.attachments).toEqual([attachments[0]]);
  recalled.attachments[0].path='/mutated';history.reset();
  expect(history.navigate(-1,'',0).attachments[0].path).toBe('/uploads/image.png');
  expect(history.navigate(1,'',0)?.text).toBe('');
});
