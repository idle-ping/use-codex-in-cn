import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { root, launchOptions } from './browser-runtime.mjs';

const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port))})});
const base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','run','server.ts'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port)},stdout:'ignore',stderr:'ignore'});
let browser;
try{
  for(let i=0;i<400;i++){try{if((await fetch(`${base}/api/health`)).ok)break}catch{}await Bun.sleep(50)}
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext();
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.modelLoadStatus==='ready');
  await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug;
    if(api.state.ws)api.state.ws.onmessage=null;
    api.state.events?.close();api.state.transport='sse';
    window.__sendHolds=new Set();window.__sendDelayed=new Map();window.__sendCalls=[];
    window.__sendOldItems=[{id:'older-user',type:'userMessage',content:[{type:'text',text:'Slow message'}]}];
    const original=window.fetch;
    window.fetch=async(resource,options={})=>{
      const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
      if(url.pathname!=='/api/rpc')return original(resource,options);
      const call=JSON.parse(options.body);window.__sendCalls.push(call);
      const key=call.method;
      if(window.__sendHolds.has(key))return new Promise((resolve,reject)=>window.__sendDelayed.set(key,{resolve:result=>resolve(Response.json({type:'rpc/result',id:call.id,result})),reject}));
      if(window.__sendReject&&key==='turn/start')return Response.json({type:'rpc/error',id:call.id,error:'Rejected message'});
      const id=call.params.threadId||'new-thread';
      const thread={id,name:id,cwd:api.state.config.defaultCwd,canAcceptDirectInput:true,turns:id==='A'?[{id:'older-turn',status:'completed',items:window.__sendOldItems}]:[]};
      return Response.json({type:'rpc/result',id:call.id,result:{thread,data:api.state.threads,turn:{id:'accepted-turn'}}});
    };
    api.startNewTask();window.__sendHolds.add('thread/start');window.__sendHolds.add('turn/start');
  });
  await page.locator('#prompt').fill('Immediate first message');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__sendDelayed.has('thread/start'));
  assert.equal(await page.locator('.user-message').textContent(),'Immediate first message');
  assert.equal(await page.locator('.user-turn').getAttribute('data-delivery'),'sending');
  assert.equal(await page.locator('#prompt').inputValue(),'');
  await page.evaluate(()=>window.__sendDelayed.get('thread/start').resolve({thread:{id:'new-thread',name:'new-thread',cwd:globalThis.__codexWebuiDebug.state.config.defaultCwd,turns:[],canAcceptDirectInput:true}}));
  await page.waitForFunction(()=>window.__sendDelayed.has('turn/start'));
  assert.equal(await page.locator('.user-message').textContent(),'Immediate first message');
  await page.locator('#prompt').fill('Duplicate during creation');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  assert.equal(await page.evaluate(()=>window.__sendCalls.filter(call=>call.method==='turn/start').length),1);
  assert.equal(await page.locator('.user-message').count(),1);
  await page.locator('#prompt').fill('');
  // Receiving the echoed message releases the composer even before the RPC ack.
  await page.evaluate(()=>{const api=globalThis.__codexWebuiDebug;api.notify('turn/started',{threadId:'new-thread',turn:{id:'accepted-turn'}});api.notify('item/completed',{threadId:'new-thread',turnId:'accepted-turn',item:{id:'first-echo',type:'userMessage',content:[{type:'text',text:'Immediate first message'}]}});window.__sendHolds.add('turn/steer')});
  await page.locator('#prompt').fill('Steer after early echo');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__sendDelayed.has('turn/steer'));
  await page.evaluate(()=>{window.__sendHolds.delete('turn/start');window.__sendDelayed.get('turn/start').resolve({turn:{id:'accepted-turn'}})});
  await page.locator('#prompt').fill('Duplicate during steer');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  assert.equal(await page.evaluate(()=>window.__sendCalls.filter(call=>call.method==='turn/steer').length),1);
  await page.locator('#prompt').fill('');
  await page.evaluate(()=>{window.__sendHolds.clear();window.__sendDelayed.get('turn/steer').resolve({turnId:'accepted-turn'})});

  await page.waitForFunction(()=>document.querySelector('.user-turn')?.dataset.delivery==='sent');
  // Repeated text from an older turn must not consume the new pending bubble.
  await page.evaluate(async()=>{
    const api=globalThis.__codexWebuiDebug;
    api.state.threads=['A','B'].map(id=>({id,name:id,cwd:api.state.config.defaultCwd,turns:[]}));
    await api.openThread('A');api.state.active.canAcceptDirectInput=false;
    window.__sendDelayed.clear();window.__sendHolds.add('thread/resume');window.__sendHolds.add('turn/start');
  });
  await page.locator('#prompt').fill('Slow message');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__sendDelayed.has('thread/resume'));
  assert.equal(await page.locator('.user-turn[data-delivery=sending]').count(),1);
  await page.evaluate(()=>window.__sendDelayed.get('thread/resume').resolve({thread:{id:'A',canAcceptDirectInput:true}}));
  await page.waitForFunction(()=>window.__sendDelayed.has('turn/start'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  assert.equal(await page.locator('.user-turn[data-delivery=sending]').count(),1);
  assert.equal(await page.locator('.user-message').count(),2);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('B'));
  assert.equal(await page.locator('.user-turn[data-delivery=sending]').count(),0);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  assert.equal(await page.locator('.user-turn[data-delivery=sending]').count(),1);
  await page.evaluate(()=>{window.__sendHolds.clear();window.__sendDelayed.get('turn/start').resolve({turn:{id:'accepted-A'}})});
  await page.waitForFunction(()=>document.querySelector('.user-turn[data-delivery=sent]'));
  await page.evaluate(()=>{const api=globalThis.__codexWebuiDebug;api.notify('item/completed',{threadId:'A',turnId:'accepted-A',item:{id:'echo-A',type:'userMessage',content:[{type:'text',text:'Slow message'}]}})});
  assert.equal(await page.locator('.user-message').count(),2);
  assert.equal(await page.locator('.user-turn[data-optimistic-user=true]').count(),0);
  // A lost acknowledgement retains the message without automatically resending it.
  await page.evaluate(()=>{window.__sendHolds.add('turn/start');window.__sendDelayed.clear()});
  await page.locator('#prompt').fill('Acknowledgement lost');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.__sendDelayed.has('turn/start'));
  const before=await page.evaluate(()=>window.__sendCalls.filter(call=>call.method==='turn/start').length);
  await page.evaluate(()=>{window.__sendHolds.clear();window.__sendDelayed.get('turn/start').reject(new TypeError('Network unavailable'))});
  await page.waitForFunction(()=>document.querySelector('.user-turn[data-delivery=unconfirmed]'));
  assert.equal(await page.locator('.user-turn[data-delivery=unconfirmed] .user-message').textContent(),'Acknowledgement lost');
  assert.equal(await page.evaluate(()=>window.__sendCalls.filter(call=>call.method==='turn/start').length),before);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.notify('item/completed',{threadId:'A',turnId:'late-turn',item:{id:'late-echo',type:'userMessage',content:[{type:'text',text:'Acknowledgement lost'}]}}));
  assert.equal(await page.locator('.user-turn[data-delivery=unconfirmed]').count(),0);
  await page.evaluate(()=>{window.__sendReject=true});
  await page.locator('#prompt').fill('Rejected message');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.querySelector('.user-turn[data-delivery=failed]'));
  assert.equal(await page.locator('#prompt').inputValue(),'Rejected message');
  assert.equal(await page.locator('.user-turn[data-delivery=failed] .user-message').textContent(),'Rejected message');
  assert.deepEqual(errors,[]);
  console.log('Weak-network immediate display, history preservation, session isolation, echo merging and failure states passed.');
}finally{await browser?.close();server.kill();await server.exited}
