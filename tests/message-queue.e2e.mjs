import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { root, launchOptions } from './browser-runtime.mjs';
const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port))})});
const base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','run','server.ts'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port)},stdout:'ignore',stderr:'ignore'});
let browser;
async function fixture(page,entries=[]){
  await page.evaluate(async entries=>{
    const api=globalThis.__codexWebuiDebug;
    if(api.state.ws)api.state.ws.onmessage=null;api.state.events?.close();api.state.transport='sse';
    window.__queueCalls=[];window.__queueEntries=entries;window.__queueHold=false;window.__queueReject=false;window.__queueLost=false;window.__createHold=false;
    const original=window.fetch;
    window.fetch=async(resource,options={})=>{
      const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
      if(url.pathname!=='/api/rpc')return original(resource,options);
      const call=JSON.parse(options.body);window.__queueCalls.push(call);
      const respond=result=>Response.json({type:'rpc/result',id:call.id,result});
      const id=call.params.threadId||'new-queue-thread';
      if(call.method==='thread/start'&&window.__createHold)return new Promise(resolve=>window.__createRelease=()=>resolve(respond({thread:{id,canAcceptDirectInput:true,cwd:api.state.config.defaultCwd,turns:[]}})));
      if(call.method==='thread/queue/list')return respond({data:id==='B'?[]:window.__queueEntries,nextCursor:null});
      if(call.method==='thread/queue/add'){
        if(window.__queueReject)return Response.json({type:'rpc/error',id:call.id,error:'Queue rejected'});
        const queuedSubmission={id:`native-${call.params.clientUserMessageId}`,clientUserMessageId:call.params.clientUserMessageId,input:call.params.input};
        const accept=()=>{window.__queueEntries.push(queuedSubmission);api.notify('thread/queue/changed',{threadId:id});return respond({queuedSubmission})};
        if(window.__queueLost){window.__queueEntries.push(queuedSubmission);throw new TypeError('Ack lost')}
        if(window.__queueHold)return new Promise(resolve=>window.__queueRelease=()=>resolve(accept()));
        return accept();
      }
      if(call.method==='thread/queue/delete'){window.__queueEntries=window.__queueEntries.filter(entry=>entry.id!==call.params.queuedSubmissionId);api.notify('thread/queue/changed',{threadId:id});return respond({})}
      const thread={id,name:id,cwd:api.state.config.defaultCwd,canAcceptDirectInput:true,turns:id==='A'?[{id:'old-turn',status:'inProgress',items:[{id:'old-user',type:'userMessage',content:[{type:'text',text:'Same text'}]}]}]:[]};
      return respond({thread,data:api.state.threads});
    };
    api.state.threads=['A','B'].map(id=>({id,name:id,cwd:api.state.config.defaultCwd,turns:[]}));await api.openThread('A');
    api.notify('turn/started',{threadId:'A',turn:{id:'old-turn'}});
  },entries);
}
try{
  for(let i=0;i<400;i++){try{if((await fetch(`${base}/api/health`)).ok)break}catch{}await Bun.sleep(50)}
  browser=await chromium.launch(launchOptions());const context=await browser.newContext();
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.modelLoadStatus==='ready');await fixture(page);
  assert.equal(await page.locator('[data-composer-control=dictation]').count(),0);
  await page.evaluate(()=>window.__queueHold=true);await page.locator('#prompt').fill('Same text');await page.locator('#queueButton').click();
  await page.waitForFunction(()=>Boolean(window.__queueRelease));
  assert.equal(await page.locator('.message-queue-row[data-status=sending]').textContent(),'Same textQueueing…');assert.equal(await page.locator('#prompt').inputValue(),'');
  await page.locator('#prompt').fill('Blocked duplicate');assert.equal(await page.locator('#queueButton').isDisabled(),true);
  await page.locator('#prompt').press('Tab');assert.equal(await page.evaluate(()=>window.__queueCalls.filter(call=>call.method==='thread/queue/add').length),1);
  await page.locator('#prompt').fill('');await page.evaluate(()=>{window.__queueHold=false;window.__queueRelease()});
  await page.waitForFunction(()=>document.querySelector('.message-queue-row')?.dataset.status==='queued');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('B'));assert.equal(await page.locator('#messageQueue').isVisible(),false);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));await page.waitForFunction(()=>document.querySelector('.message-queue-row[data-status=queued]'));
  // A new browser reads the native queue, rather than relying on the first page's memory.
  const saved=await page.evaluate(()=>window.__queueEntries);const second=await context.newPage();await second.goto(base,{waitUntil:'networkidle'});await second.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.modelLoadStatus==='ready');await fixture(second,saved);
  await second.waitForFunction(()=>document.querySelector('.message-queue-row[data-status=queued]'));assert.equal(await second.locator('.message-queue-text').textContent(),'Same text');await second.close();
  // The queue disappears from the server before the echo; retain the text until it arrives.
  const clientId=saved[0].clientUserMessageId;
  await page.evaluate(()=>{window.__queueEntries=[];globalThis.__codexWebuiDebug.notify('thread/queue/changed',{threadId:'A'})});
  await page.waitForFunction(()=>document.querySelector('.message-queue-row')?.dataset.status==='starting');
  await page.evaluate(clientId=>{const api=globalThis.__codexWebuiDebug;api.notify('turn/started',{threadId:'A',turn:{id:'next-turn'}});api.notify('item/started',{threadId:'A',turnId:'next-turn',item:{id:'queue-echo',clientId,type:'userMessage',content:[{type:'text',text:'Same text'}]}})},clientId);
  assert.equal(await page.locator('#messageQueue').isVisible(),false);assert.equal(await page.locator('.user-message').count(),2);
  // Tab queues, but composition confirmation and Shift+Tab do not.
  await page.locator('#prompt').fill('Tab message');
  await page.locator('#prompt').evaluate(input=>{input.dispatchEvent(new CompositionEvent('compositionstart'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));input.dispatchEvent(new CompositionEvent('compositionend'))});
  assert.equal(await page.evaluate(()=>window.__queueCalls.filter(call=>call.method==='thread/queue/add').length),1);
  await page.locator('#prompt').press('Shift+Tab');await page.locator('#prompt').focus();await page.locator('#prompt').press('Tab');
  await page.waitForFunction(()=>document.querySelector('.message-queue-row[data-status=queued]'));await page.locator('.message-queue-cancel').click();await page.waitForFunction(()=>document.querySelector('#messageQueue').hidden);
  // Rejections restore the draft; lost acks reconcile using the server snapshot, without retrying add.
  await page.evaluate(()=>window.__queueReject=true);await page.locator('#prompt').fill('Rejected draft');await page.locator('#queueButton').click();await page.waitForFunction(()=>document.querySelector('.message-queue-row[data-status=failed]'));
  assert.equal(await page.locator('#prompt').inputValue(),'Rejected draft');await page.locator('.message-queue-cancel').click();
  await page.evaluate(()=>{window.__queueReject=false;window.__queueLost=true});await page.locator('#prompt').fill('Lost ack');await page.locator('#queueButton').click();await page.waitForFunction(()=>document.querySelector('.message-queue-row[data-status=queued]'));
  assert.equal(await page.evaluate(()=>window.__queueCalls.filter(call=>call.method==='thread/queue/add'&&call.params.input[0].text==='Lost ack').length),1);
  await page.locator('.message-queue-cancel').click();await page.waitForFunction(()=>document.querySelector('#messageQueue').hidden);
  await page.evaluate(()=>{window.__queueLost=false;window.__createHold=true;globalThis.__codexWebuiDebug.startNewTask()});await page.locator('#prompt').fill('New session queue');await page.locator('#queueButton').click();await page.waitForFunction(()=>Boolean(window.__createRelease));
  assert.equal(await page.locator('.message-queue-text').textContent(),'New session queue');await page.evaluate(()=>window.__createRelease());await page.waitForFunction(()=>document.querySelector('.message-queue-row[data-status=queued]'));
  assert.equal(await page.evaluate(()=>window.__queueCalls.some(call=>call.method==='turn/steer'||call.method==='turn/start')),false);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('#queueButton').isVisible(),true);assert.ok(await page.locator('#queueButton').evaluate(node=>node.getBoundingClientRect().right<=innerWidth));
  await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('zh-CN'));await page.locator('#prompt').fill('Queue');await page.locator('#queueButton').click();await page.waitForFunction(()=>document.querySelectorAll('.message-queue-row[data-status=queued]').length===2);
  assert.equal(await page.locator('.message-queue-text').last().textContent(),'Queue');assert.equal(await page.locator('.message-queue-status').last().textContent(),'已排队');assert.ok((await page.locator('#queueButton').textContent()).includes('排队'));
  assert.deepEqual(errors,[]);console.log('message queue e2e passed');
}finally{await browser?.close();server.kill();await server.exited}
