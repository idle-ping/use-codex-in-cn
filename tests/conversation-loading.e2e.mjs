import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { root, launchOptions } from './browser-runtime.mjs';
import { createConversationHistory } from '../conversation-history-service.js';

const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port))})});
const testDirectory=await mkdtemp(join(tmpdir(),'conversation-cache-'));
const server=Bun.spawn(['bun','run','server.ts'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_AUTH_STORE:join(testDirectory,'auth.json'),CODEX_WEBUI_PASSWORD:'',CODEX_WEBUI_ACCESS_TOKEN:''},stdout:'ignore',stderr:'ignore'});
let browser;
try{
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<400;i++){try{if((await fetch(`${base}/api/health`)).ok)break}catch{}await Bun.sleep(50)}
 const thread={id:'paged',cwd:'/tmp',turns:[{id:'turn',status:'completed',items:Array.from({length:250},(_,i)=>i===0?{id:'user',type:'userMessage',content:[{type:'text',text:'Original prompt'}]}:i===249?{id:'final',type:'agentMessage',phase:'final_answer',text:'Latest answer'}:{id:`tool-${i}`,type:'commandExecution',status:'completed',command:'echo history',aggregatedOutput:`output ${i}`})}]};
 const history=createConversationHistory({readThread:async()=>thread,fingerprint:()=>1});
 const first=await history.read({threadId:'paged'}),second=await history.read({threadId:'paged',cursor:first.history.nextCursor}),third=await history.read({threadId:'paged',cursor:second.history.nextCursor});
 const unchanged=await history.read({threadId:'paged',revision:first.history.revision,oldestItemId:third.history.oldestItemId});
 browser=await chromium.launch(launchOptions());const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
 await page.evaluate(({first,second,third,unchanged})=>{
  const api=globalThis.__codexWebuiDebug;api.state.ws.onmessage=null;api.state.events?.close();api.state.transport='sse';api.startNewTask();
  api.applyThreadSummaries([{id:'paged',name:'Paged history',cwd:'/tmp'},{id:'other',name:'Other',cwd:'/tmp'}]);
  window.__historyCalls=[];window.__holdHistory=false;const original=window.fetch;
  window.fetch=async(resource,options={})=>{
   if(new URL(typeof resource==='string'?resource:resource.url,location.href).pathname!=='/api/rpc')return original(resource,options);
   const call=JSON.parse(options.body);window.__historyCalls.push(call);let result={data:[]};
   if(call.method==='host/thread/history'){
    if(call.params.threadId==='other')result={thread:{id:'other',turns:[]},history:{mode:'snapshot',turns:[],revision:'other'}};
    else if(call.params.cursor)result=call.params.cursor===first.history.nextCursor?second:third;
    else if(call.params.revision)result=unchanged;
    else result=first;
    if(window.__holdHistory&&call.params.threadId==='paged')return new Promise(resolve=>window.__resolveHistory=()=>resolve(Response.json({type:'rpc/result',id:call.id,result})));
   }
   return Response.json({type:'rpc/result',id:call.id,result});
  };
 },{first,second,third,unchanged});
 await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('paged'));
 assert.equal(await page.locator('.activity-item').count(),99);assert.equal((await page.locator('[data-local-conversation-final-assistant]').textContent()).trim(),'Latest answer');
 await page.locator('.load-older').click();await page.waitForFunction(()=>document.querySelectorAll('.activity-item').length===199);assert.equal(await page.locator('.activity-item').count(),199);
 await page.locator('.load-older').click();await page.waitForFunction(()=>document.querySelectorAll('.activity-item').length===248);assert.equal(await page.locator('.activity-item').count(),248);assert.equal(await page.locator('.user-message').textContent(),'Original prompt');assert.equal(await page.locator('.load-older').count(),0);
 await page.evaluate(async()=>{await globalThis.__codexWebuiDebug.openThread('other');window.__holdHistory=true;window.__cachedOpen=globalThis.__codexWebuiDebug.openThread('paged')});
 assert.equal((await page.locator('[data-local-conversation-final-assistant]').textContent()).trim(),'Latest answer');assert.equal(await page.locator('.conversation-loading').count(),0);
 await page.waitForFunction(()=>window.__resolveHistory);await page.evaluate(async()=>{window.__resolveHistory();await window.__cachedOpen;window.__holdHistory=false});
 assert.equal(await page.locator('.activity-item').count(),248);
 const calls=await page.evaluate(()=>window.__historyCalls);assert.equal(calls.some(call=>call.method==='thread/read'),false);assert.ok(calls.some(call=>call.params?.revision&&call.params?.oldestItemId));assert.deepEqual(errors,[]);
 // A real page reload must show persisted content before either network history or the list returns.
 const saved=await page.evaluate(()=>globalThis.__codexWebuiDebug.persistentConversationCache.get('paged'));
 assert.equal(saved.history.revision,first.history.revision);assert.equal(saved.turns[0].items.length,100);
 const reloadStarted=performance.now();
 await page.addInitScript(()=>{const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(url,...args){if(String(url).endsWith('/ws'))throw new Error('Use SSE for reload test');super(url,...args)}}});
 const held=[];
 let connection;
 await page.route('**/api/events',route=>{connection=route});
 await page.route('**/api/rpc',async route=>{
  const call=route.request().postDataJSON();
  if(call.method==='thread/list'){held.push({route,result:{data:[{id:'paged',name:'Paged history',cwd:'/tmp'}]}});return}
  if(call.method==='host/thread/history'){held.push({route,result:await history.read(call.params),call});return}
  await route.fulfill({json:{type:'rpc/result',id:call.id,result:{data:[]}}});
 });
 const syncRequest=page.waitForRequest(request=>request.url().endsWith('/api/rpc')&&request.postDataJSON()?.method==='host/thread/history');
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForSelector('[data-local-conversation-final-assistant]');
 const cachedReloadMs=Math.round(performance.now()-reloadStarted);
 assert.equal((await page.locator('[data-local-conversation-final-assistant]').textContent()).trim(),'Latest answer');
 assert.equal(await page.locator('.conversation-loading').count(),0);
 assert.equal(await page.locator('.activity-item').count(),99);
 assert.equal(await page.locator('.load-older').count(),1);
 assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.connected),false);
 assert.ok(connection);await connection.continue();await page.unroute('**/api/events');
 const revalidation=(await syncRequest).postDataJSON();assert.equal(revalidation.params.revision,first.history.revision);assert.equal(revalidation.params.oldestItemId,'turn:tool-150');
 for(let attempt=0;attempt<100&&!held.some(value=>value.call);attempt++)await Bun.sleep(10);
 assert.equal(held.find(value=>value.call)?.result.history.mode,'delta');
 assert.equal(held.find(value=>value.call)?.result.history.turns.length,0);
 for(const {route,result} of held)await route.fulfill({json:{type:'rpc/result',id:route.request().postDataJSON().id,result}});
 await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.active?.history?.unchanged===true);
 assert.deepEqual(errors,[]);
 const eviction=await page.evaluate(async()=>{
  const cache=globalThis.__codexWebuiDebug.persistentConversationCache,now=Date.now(),hour=60*60*1000;
  const old={id:'expired',updatedAt:(now-49*hour)/1000,turns:[]};
  await cache.put(old);const expiredWrite=await cache.get(old.id)===null;
  const recent={id:'recent',updatedAt:(now-47*hour)/1000,turns:[]};
  await cache.put(recent);const recentRetained=Boolean(await cache.get(recent.id));
  const originalNow=Date.now;let expiredAfterRefresh;
  try{Date.now=()=>now+2*hour;await cache.put(recent);expiredAfterRefresh=await cache.get(recent.id)===null}finally{Date.now=originalNow}
  // Seed an entry written by the previous cache version to verify physical cleanup.
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('codex-webui-conversations-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
  const access=(mode,action)=>new Promise((resolve,reject)=>{const tx=db.transaction('entries',mode);action(tx.objectStore('entries'));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
  await access('readwrite',store=>store.put({id:'legacy',updatedAt:now,thread:{...old,id:'legacy'}}));
  await cache.prune();let legacy;
  await access('readonly',store=>{const request=store.get('legacy');request.onsuccess=()=>legacy=request.result});
  const deleted={id:'cache-delete',updatedAt:now/1000,turns:[]};
  await cache.put(deleted);await cache.saveSummaries([{id:'cache-delete'},{id:'paged'}]);
  await cache.remove(deleted.id);await cache.put(deleted);
  let deletedRecord;await access('readonly',store=>{const request=store.get(deleted.id);request.onsuccess=()=>deletedRecord=request.result});db.close();
  const deletionEvicted=!deletedRecord&&await cache.get(deleted.id)===null&&!(await cache.summaries()).some(thread=>thread.id===deleted.id);
  const recoverable={id:'recoverable',updatedAt:now/1000,turns:[]};
  await cache.put(recoverable);await cache.discard(recoverable.id);await cache.put(recoverable);
  const discardKeepsCacheWritable=Boolean(await cache.get(recoverable.id));
  return {expiredWrite,recentRetained,expiredAfterRefresh,legacyPruned:!legacy,deletionEvicted,discardKeepsCacheWritable};
 });
 assert.deepEqual(eviction,{expiredWrite:true,recentRetained:true,expiredAfterRefresh:true,legacyPruned:true,deletionEvicted:true,discardKeepsCacheWritable:true});
 // Storage restrictions must leave network loading usable.
 await page.addInitScript(()=>Object.defineProperty(globalThis,'indexedDB',{get(){throw new DOMException('Storage disabled','SecurityError')}}));
 await page.unroute('**/api/rpc');
 let deletedByUI=false;
 await page.route('**/api/rpc',route=>{const call=route.request().postDataJSON();if(call.method==='thread/delete')deletedByUI=true;const result=call.method==='host/thread/history'?first:call.method==='thread/list'?{data:deletedByUI?[]:[{id:'paged',name:'Paged history',cwd:'/tmp'}]}:{data:[]};return route.fulfill({json:{type:'rpc/result',id:call.id,result}})});
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('[data-local-conversation-final-assistant]');
 assert.equal((await page.locator('[data-local-conversation-final-assistant]').textContent()).trim(),'Latest answer');assert.deepEqual(errors,[]);
 page.on('dialog',dialog=>dialog.accept());await page.locator('.thread-item[data-id="paged"] .thread-delete').click();
 await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.active===null);
 assert.equal(deletedByUI,true);await page.waitForFunction(()=>!globalThis.__codexWebuiDebug.state.threads.some(thread=>thread.id==='paged'));
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({boundedHistory:true,olderPages:true,persistentReloadBeforeNetwork:true,cachedReloadMs,revisionRevalidation:true,storageUnavailableFallback:true,inactive48HourEviction:true,deletionEviction:true}));
}finally{await browser?.close();server.kill();await server.exited;await rm(testDirectory,{recursive:true,force:true})}
