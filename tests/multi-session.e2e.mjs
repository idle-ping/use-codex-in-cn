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
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug);
  await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug;
    if(api.state.ws)api.state.ws.onmessage=null;
    api.state.events?.close();
    api.state.transport='sse';
    window.calls=[];window.delayed=new Map();window.hold=new Set();
    const original=window.fetch;
    window.fetch=async(resource,options={})=>{
      const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
      if(url.pathname!=='/api/rpc'&&url.pathname!=='/api/codex/respond')return original(resource,options);
      const call=JSON.parse(options.body);window.calls.push(call);
      if(url.pathname==='/api/codex/respond')return Response.json({type:'ack'});
      const key=`${call.method}:${call.params.threadId||''}`;
      if(window.hold.has(key))return new Promise(resolve=>window.delayed.set(key,result=>resolve(Response.json({type:'rpc/result',id:call.id,result}))));
      const thread={id:call.params.threadId,name:call.params.threadId,cwd:api.state.config.defaultCwd,turns:[],canAcceptDirectInput:true};
      return Response.json({type:'rpc/result',id:call.id,result:{thread,data:[]}});
    };
    api.state.threads=['A','B'].map(id=>({id,name:id,cwd:api.state.config.defaultCwd,turns:[],canAcceptDirectInput:true}));
  });
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  const isolated=await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug;
    api.notify('turn/started',{threadId:'A',turn:{id:'turn-A'}});
    api.notify('item/started',{threadId:'A',turnId:'turn-A',item:{id:'message-A',type:'agentMessage',text:'A only'}});
    const before=document.querySelector('#conversation').innerHTML;
    api.notify('item/started',{threadId:'B',turnId:'turn-B',item:{id:'message-B',type:'agentMessage',text:'B secret'}});
    api.notify('item/agentMessage/delta',{threadId:'B',turnId:'turn-B',itemId:'message-B',delta:'more B'});
    api.notify('item/fileChange/patchUpdated',{threadId:'B',turnId:'turn-B',itemId:'patch-B',changes:[]});
    api.notify('turn/completed',{threadId:'B',turn:{id:'turn-B',status:'completed',items:[{id:'final-B',type:'agentMessage',text:'B final'}]}});
    return {unchanged:before===document.querySelector('#conversation').innerHTML,turn:document.querySelector('#sendButton').dataset.turnId};
  });
  assert.deepEqual(isolated,{unchanged:true,turn:'turn-A'});

  // A slower history read must not replace B or reopen after New task.
  await page.evaluate(()=>{window.hold.add('thread/read:A');window.oldOpen=globalThis.__codexWebuiDebug.openThread('A')});
  await page.waitForFunction(()=>window.delayed.has('thread/read:A'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('B'));
  await page.evaluate(async()=>{window.delayed.get('thread/read:A')({thread:{id:'A',name:'stale A',turns:[]}});await window.oldOpen});
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'B');
  await page.evaluate(()=>{window.oldOpen=globalThis.__codexWebuiDebug.openThread('A')});
  await page.evaluate(async()=>{const api=globalThis.__codexWebuiDebug;api.startNewTask();window.delayed.get('thread/read:A')({thread:{id:'A',turns:[]}});await window.oldOpen;window.hold.delete('thread/read:A')});
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active),null);

  // Approval from B waits for B, survives navigation, and resolves across clients.
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.request({id:701,method:'item/commandExecution/requestApproval',params:{threadId:'B',turnId:'turn-B',itemId:'command-B',command:'echo B'}}));
  assert.equal(await page.locator('.approval-card').count(),0);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('B'));
  assert.equal(await page.locator('.approval-card').count(),1);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('B'));
  assert.equal(await page.locator('.approval-card').count(),1);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.notify('serverRequest/resolved',{requestId:701}));
  assert.equal(await page.locator('.approval-card').count(),0);

  // A pending resume continues sending to its original session after navigation.
  await page.evaluate(()=>{const api=globalThis.__codexWebuiDebug;api.state.active.canAcceptDirectInput=false;window.hold.add('thread/resume:B')});
  await page.locator('#prompt').fill('B draft waiting for resume');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.delayed.has('thread/resume:B'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  await page.locator('#prompt').fill('A independent draft');
  await page.evaluate(()=>window.delayed.get('thread/resume:B')({thread:{id:'B',name:'resumed B'}}));
  await page.waitForFunction(()=>window.calls.some(call=>call.method==='turn/start'));
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'A');
  assert.equal(await page.locator('#prompt').inputValue(),'A independent draft');
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(call=>call.method==='turn/start').map(call=>({threadId:call.params.threadId,text:call.params.input[0].text}))),[{threadId:'B',text:'B draft waiting for resume'}]);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('B'));
  assert.equal(await page.locator('#prompt').inputValue(),'');
  assert.equal(await page.locator('.user-turn[data-delivery=sent] .user-message').textContent(),'B draft waiting for resume');
  assert.equal(await page.locator('.user-turn[data-delivery=failed]').count(),0);
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  assert.equal(await page.locator('#prompt').inputValue(),'A independent draft');
  // Creating a session in the background still submits its first message.
  await page.evaluate(()=>{globalThis.__codexWebuiDebug.startNewTask();window.hold.add('thread/start:')});
  await page.locator('#prompt').fill('New session background message');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.delayed.has('thread/start:'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  await page.locator('#prompt').fill('Keep A draft');
  await page.evaluate(()=>window.delayed.get('thread/start:')({thread:{id:'C',name:'C',turns:[],canAcceptDirectInput:true}}));
  await page.waitForFunction(()=>window.calls.some(call=>call.method==='turn/start'&&call.params.threadId==='C'));
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'A');
  assert.equal(await page.locator('#prompt').inputValue(),'Keep A draft');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('C'));
  assert.equal(await page.locator('#prompt').inputValue(),'');
  assert.equal(await page.locator('.user-turn[data-delivery=sent] .user-message').textContent(),'New session background message');

  // Steering after a slow resume also retains the original destination.
  await page.evaluate(async()=>{const api=globalThis.__codexWebuiDebug;await api.openThread('B');api.state.active.canAcceptDirectInput=false;api.notify('turn/started',{threadId:'B',turn:{id:'steer-B'}});window.delayed.delete('thread/resume:B')});
  await page.locator('#prompt').fill('Background steering message');
  await page.locator('#composer').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>window.delayed.has('thread/resume:B'));
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('A'));
  await page.evaluate(()=>window.delayed.get('thread/resume:B')({thread:{id:'B',canAcceptDirectInput:true}}));
  await page.waitForFunction(()=>window.calls.some(call=>call.method==='turn/steer'));
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(call=>call.method==='turn/steer').map(call=>({threadId:call.params.threadId,turnId:call.params.expectedTurnId,text:call.params.input[0].text}))),[{threadId:'B',turnId:'steer-B',text:'Background steering message'}]);
  assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id),'A');
  assert.equal(await page.locator('#prompt').inputValue(),'Keep A draft');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('B'));
  assert.equal(await page.locator('.user-turn[data-delivery=failed]').count(),0);
  assert.equal(await page.locator('.user-turn[data-delivery=sent]').count(),2);
  assert.deepEqual(errors,[]);
  console.log('Multi-session isolation, navigation races, approvals, resume and drafts passed.');
}finally{
  await browser?.close();server.kill();await server.exited;
}
