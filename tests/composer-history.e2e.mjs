import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { launchOptions } from './browser-runtime.mjs';

const root=new URL('..',import.meta.url).pathname;
async function freePort(){return await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();if(!address||typeof address==='string')return reject(new Error('Could not allocate composer test port'));probe.close(error=>error?reject(error):resolve(address.port))})})}
async function waitFor(check,timeout=20_000){const started=Date.now();while(Date.now()-started<timeout){try{if(await check())return}catch{}await Bun.sleep(50)}throw new Error('Timed out waiting for composer test server')}

const port=await freePort(),base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','run','server.ts'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port)},stdout:'ignore',stderr:'ignore'});
let browser;
try{
  await waitFor(async()=>(await fetch(`${base}/api/health`)).ok);
  const historyResponse=await fetch(`${base}/api/composer/history`);
  assert.equal(historyResponse.status,200);
  assert.equal(historyResponse.headers.get('cache-control'),'no-store');
  assert.ok(Array.isArray((await historyResponse.json()).entries));
  assert.equal((await fetch(`${base}/api/composer/history`,{method:'POST'})).status,405);
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({viewport:{width:1018,height:760},colorScheme:'dark'});
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/composer/history',route=>route.fulfill({json:{entries:[{text:'older CLI message'},{text:'first line\nsecond line'}]}}));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.syncTurnSnapshot);
  const prompt=page.locator('#prompt');
  await prompt.focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'first line\nsecond line');
  // Interior positions move vertically; endpoint positions continue recall.
  await page.evaluate(()=>document.querySelector('#prompt').setSelectionRange(6,6));
  await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'first line\nsecond line');
  await page.evaluate(()=>document.querySelector('#prompt').setSelectionRange(0,0));
  await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'older CLI message');
  await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'older CLI message');
  await page.keyboard.press('ArrowDown');
  assert.equal(await prompt.inputValue(),'first line\nsecond line');
  await page.keyboard.press('ArrowDown');
  assert.equal(await prompt.inputValue(),'');
  await prompt.fill('fresh draft');await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'fresh draft');
  await prompt.fill('');await page.keyboard.press('ArrowUp');
  await page.keyboard.type(' edited');await page.keyboard.press('ArrowDown');
  assert.equal(await prompt.inputValue(),'first line\nsecond line edited');
  await prompt.fill('');
  await page.evaluate(()=>{
    const input=document.querySelector('#prompt');
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
  });
  assert.equal(await prompt.inputValue(),'');
  await page.evaluate(()=>document.querySelector('#prompt').dispatchEvent(new CompositionEvent('compositionend')));
  await prompt.fill('/');await page.keyboard.press('ArrowDown');
  assert.equal(await prompt.inputValue(),'/');
  assert.equal(await page.locator('#composerAutocomplete [aria-selected="true"]').getAttribute('data-autocomplete-id'),'plan');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug;
    api.state.active={id:'history-thread',cwd:api.state.config.defaultCwd,turns:[],canAcceptDirectInput:true};
    api.state.composerMentions=[{id:'file:package.json',title:'package.json',path:'package.json',source:'file'}];
    api.state.transport='sse';
    const original=window.fetch;
    window.fetch=async(resource,options={})=>{
      const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
      if(url.pathname==='/api/rpc'){
        const payload=JSON.parse(options.body||'{}');
        if(payload.method==='host/thread/history')return Response.json({type:'rpc/error',id:payload.id,error:'Unsupported method'});
        if(payload.method==='thread/read')return Response.json({type:'rpc/result',id:payload.id,result:{thread:{id:payload.params.threadId,name:'Resumed',cwd:globalThis.__codexWebuiDebug.state.config.defaultCwd,turns:[{id:'resumed-turn',status:'completed',items:[{id:'resumed-user',type:'userMessage',content:[{type:'text',text:'resumed prompt'}]}]}],canAcceptDirectInput:true}}});
        if(payload.method==='turn/start')return Response.json({type:'rpc/result',id:payload.id,result:{turn:{id:'history-turn'}}});
        if(payload.method==='thread/queue/add')return Response.json({type:'rpc/result',id:payload.id,result:{queuedSubmission:{id:'history-queue'}}});
        if(payload.method==='thread/queue/list')return Response.json({type:'rpc/result',id:payload.id,result:{data:[]}});
      }
      return original(resource,options);
    };
  });
  await prompt.fill('use selected file');await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'use selected file');
  assert.equal(await page.locator('#composerContextTray [data-context-id="file:package.json"]').count(),1);
  await page.keyboard.press('ArrowDown');assert.equal(await prompt.inputValue(),'');
  assert.equal(await page.locator('#composerContextTray').isHidden(),true);
  await prompt.fill('queued message');await page.keyboard.press('Tab');
  await page.waitForFunction(()=>document.querySelector('#prompt').value==='');
  await page.keyboard.press('ArrowUp');assert.equal(await prompt.inputValue(),'queued message');
  await page.click('#newTask');await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'queued message');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('resumed-thread'));
  await prompt.focus();await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'queued message');
  await page.keyboard.press('ArrowUp');assert.equal(await prompt.inputValue(),'use selected file');
  await page.keyboard.press('ArrowUp');assert.equal(await prompt.inputValue(),'resumed prompt');
  await prompt.fill('resumed draft');
  await page.click('#newTask');await page.keyboard.press('ArrowDown');
  assert.equal(await prompt.inputValue(),'');
  await page.evaluate(()=>globalThis.__codexWebuiDebug.openThread('resumed-thread'));
  await prompt.focus();await page.keyboard.press('ArrowUp');
  assert.equal(await prompt.inputValue(),'resumed draft');
  assert.deepEqual(errors,[]);
  console.log('Composer history browser checks passed');
}finally{
  await browser?.close();server.kill();await server.exited;
}
