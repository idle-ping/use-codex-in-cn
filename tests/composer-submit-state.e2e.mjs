import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { artifact, launchOptions } from './browser-runtime.mjs';

const root=new URL('..',import.meta.url).pathname;
async function freePort(){return await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();if(!address||typeof address==='string')return reject(new Error('Could not allocate composer test port'));probe.close(error=>error?reject(error):resolve(address.port))})})}
async function waitFor(check,timeout=20_000){const started=Date.now();while(Date.now()-started<timeout){try{if(await check())return}catch{}await Bun.sleep(50)}throw new Error('Timed out waiting for composer test server')}

const port=await freePort(),base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','run','server.ts'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port)},stdout:'ignore',stderr:'ignore'});
let browser;
try{
  await waitFor(async()=>(await fetch(`${base}/api/health`)).ok);
  browser=await chromium.launch(launchOptions());
  const context=await browser.newContext({viewport:{width:1018,height:760},colorScheme:'dark'});
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.syncTurnSnapshot);
  await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug;
    api.state.active={id:'composer-thread',name:'Composer thread',cwd:api.state.config.defaultCwd,turns:[]};
    api.syncTurnSnapshot({id:'composer-turn',status:'inProgress',itemsView:'full',items:[]});
    api.notify('turn/started',{threadId:'other-thread',turn:{id:'other-turn'}});
    window.__composerRpcCalls=[];
    window.__composerOriginalFetch=window.fetch;
    window.__composerOriginalTransport=api.state.transport;
    api.state.transport='sse';
    window.fetch=async(resource,options={})=>{
      const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
      if(url.pathname==='/api/rpc'){
        const payload=JSON.parse(options.body||'{}');
        window.__composerRpcCalls.push(payload);
        if(payload.method==='turn/steer'&&window.__noActiveSteer)return Response.json({type:'rpc/error',id:payload.id,error:'no active turn to steer'});
        if(payload.method==='turn/start'&&window.__noActiveSteer){
          const api=globalThis.__codexWebuiDebug;
          api.notify('turn/started',{threadId:payload.params.threadId,turn:{id:'fallback-turn'}});
          api.notify('item/started',{threadId:payload.params.threadId,turnId:'fallback-turn',item:{id:'fallback-user',type:'userMessage',content:payload.params.input}});
          return Response.json({type:'rpc/result',id:payload.id,result:{turn:{id:'fallback-turn'}}});
        }
        if(payload.method==='turn/steer'&&window.__holdSteer)await new Promise(resolve=>{window.__releaseSteer=resolve});
        if(payload.method==='turn/steer'&&window.__failSteer)return new Response(JSON.stringify({type:'rpc/error',id:payload.id,error:'Steer rejected'}),{status:200,headers:{'content-type':'application/json'}});
        if(window.__composerConflictMode&&payload.method==='thread/resume')return new Response(JSON.stringify({type:'rpc/error',id:payload.id,error:'thread external-thread already has an active writer',code:'thread_active_writer'}),{status:200,headers:{'content-type':'application/json'}});
        return new Response(JSON.stringify({type:'rpc/result',result:{turnId:payload.params?.expectedTurnId||payload.params?.turnId||'ok'}}),{status:200,headers:{'content-type':'application/json'}});
      }
      return window.__composerOriginalFetch(resource,options);
    };
  });
  const ime=await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug,prompt=document.querySelector('#prompt'),form=document.querySelector('#composer');
    let submissions=0;
    const intercept=event=>{event.preventDefault();event.stopImmediatePropagation();submissions++};
    form.addEventListener('submit',intercept,true);
    const key=options=>{const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});prompt.dispatchEvent(event);return event.defaultPrevented};
    const scenarios=[];
    for(const status of ['completed','inProgress']){
      api.syncTurnSnapshot({id:'composer-turn',status,itemsView:'full',items:[]});
      prompt.value='拼音输入';prompt.dispatchEvent(new Event('input',{bubbles:true}));
      const before=submissions;
      prompt.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      const composingPrevented=key({isComposing:false,keyCode:13});
      prompt.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'输入'}));
      const legacyPrevented=key({keyCode:229});
      const nativePrevented=key({isComposing:true,keyCode:13});
      const keptText=prompt.value,imeSubmissions=submissions-before;
      key({shiftKey:true});
      const shiftSubmissions=submissions-before;
      const enterPrevented=key({keyCode:13});
      scenarios.push({status,composingPrevented,legacyPrevented,nativePrevented,keptText,imeSubmissions,shiftSubmissions,enterPrevented,enterSubmissions:submissions-before});
    }
    prompt.value='/plan';prompt.dispatchEvent(new Event('input',{bubbles:true}));
    const menu=document.querySelector('#composerAutocomplete'),beforePlan=api.state.planMode;
    prompt.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    for(const value of ['Enter','ArrowDown','Tab','Escape'])key({key:value,isComposing:true});
    const autocompleteUnchanged=!menu.hidden&&prompt.value==='/plan'&&api.state.planMode===beforePlan;
    prompt.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    key({keyCode:13});
    const autocompleteWorks=menu.hidden&&api.state.planMode!==beforePlan;
    // Restore the composer for the steer/stop scenarios below.
    key({key:'Escape'});
    prompt.value='/plan';prompt.dispatchEvent(new Event('input',{bubbles:true}));key({keyCode:13});
    prompt.value='';prompt.dispatchEvent(new Event('input',{bubbles:true}));
    form.removeEventListener('submit',intercept,true);
    return{scenarios,autocompleteUnchanged,autocompleteWorks};
  });
  const stop=await page.evaluate(()=>({mode:document.querySelector('#sendButton')?.dataset.submitMode,title:document.querySelector('#sendButton')?.title,turnId:document.querySelector('#sendButton')?.dataset.turnId,stopped:document.querySelector('#sendButton')?.classList.contains('stop'),square:Boolean(document.querySelector('#sendButton rect[fill="currentColor"]'))}));
  await page.screenshot({path:artifact('composer-submit-stop.png'),fullPage:false});
  await page.locator('#prompt').fill('Change direction while this task is running.');
  const steer=await page.evaluate(()=>({mode:document.querySelector('#sendButton')?.dataset.submitMode,title:document.querySelector('#sendButton')?.title,label:document.querySelector('#sendButton')?.textContent,stopped:document.querySelector('#sendButton')?.classList.contains('stop'),arrow:Boolean(document.querySelector('#sendButton path[d="M12 19V5"]'))}));
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>globalThis.__codexWebuiDebug.setSidebarOpen(false));
  const mobile=await page.evaluate(()=>{const button=document.querySelector('#sendButton').getBoundingClientRect();return{right:button.right,left:button.left,overflow:document.documentElement.scrollWidth>innerWidth}});
  await page.screenshot({path:artifact('composer-submit-steer-mobile.png'),fullPage:false});
  await page.setViewportSize({width:1018,height:760});
  await page.evaluate(()=>{window.__holdSteer=true});
  await page.click('#sendButton');
  await page.waitForFunction(()=>window.__releaseSteer);
  const pending=await page.evaluate(()=>({text:document.querySelector('.user-turn[data-steer=true] .user-message')?.textContent,status:document.querySelector('.steer-message-status')?.textContent,delivery:document.querySelector('.user-turn[data-steer=true]')?.dataset.delivery}));
  await page.screenshot({path:artifact('composer-submit-steer-pending.png'),fullPage:false});
  await page.evaluate(()=>{window.__holdSteer=false;window.__releaseSteer()});
  await page.waitForFunction(()=>document.querySelector('.user-turn[data-steer=true]')?.dataset.delivery==='sent');
  const afterSteer=await page.evaluate(()=>({input:document.querySelector('#prompt')?.value,mode:document.querySelector('#sendButton')?.dataset.submitMode,call:window.__composerRpcCalls.find(call=>call.method==='turn/steer')}));
  const echoed=await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug,item={id:'server-steer',type:'userMessage',content:[{type:'text',text:'Change direction while this task is running.'}]};
    api.notify('item/started',{threadId:'composer-thread',turnId:'composer-turn',item});
    api.notify('item/completed',{threadId:'composer-thread',turnId:'composer-turn',item});
    api.syncTurnSnapshot({id:'composer-turn',status:'inProgress',itemsView:'full',items:[{...item,id:'host-user-composer-turn-2',steer:true}]});
    api.syncTurnSnapshot({id:'composer-turn',status:'inProgress',itemsView:'full',items:[item]});
    return{count:document.querySelectorAll('.user-turn[data-steer=true]').length,status:document.querySelector('.steer-message-status')?.textContent,optimistic:document.querySelector('.user-turn[data-steer=true]')?.dataset.optimisticUser};
  });
  await page.evaluate(()=>{window.__failSteer=true});
  await page.locator('#prompt').fill('Rejected steering message.');
  await page.click('#sendButton');
  await page.waitForFunction(()=>document.querySelector('#prompt')?.value==='Rejected steering message.');
  const rejected=await page.evaluate(()=>({count:document.querySelectorAll('.user-turn[data-steer=true]').length,texts:[...document.querySelectorAll('.user-message')].map(node=>node.textContent)}));
  await page.evaluate(()=>{window.__failSteer=false});
  await page.locator('#prompt').fill('');
  await page.click('#sendButton');
  await page.waitForTimeout(100);
  const interrupt=await page.evaluate(()=>({mode:document.querySelector('#sendButton')?.dataset.submitMode,call:window.__composerRpcCalls.find(call=>call.method==='turn/interrupt')}));
  const send=await page.evaluate(()=>{const api=globalThis.__codexWebuiDebug;api.syncTurnSnapshot({id:'composer-turn',status:'completed',itemsView:'full',items:[]});const button=document.querySelector('#sendButton');return{mode:button?.dataset.submitMode,title:button?.title,stopped:button?.classList.contains('stop'),arrow:Boolean(button?.querySelector('path[d="M12 19V5"]'))}});
  const repeated=await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug,text='Change direction while this task is running.';
    api.syncTurnSnapshot({id:'composer-turn',status:'completed',itemsView:'full',items:[{id:'server-steer-2',type:'userMessage',steer:true,content:[{type:'text',text}]}]});
    api.syncTurnSnapshot({id:'composer-turn',status:'completed',itemsView:'full',items:[{id:'host-user-composer-turn-3',type:'userMessage',steer:true,content:[{type:'text',text}]}]});
    return [...document.querySelectorAll('.user-turn[data-steer=true]')].filter(node=>node.querySelector('.user-message')?.textContent===text).length;
  });
  // The server completed the turn before the client received its notification.
  await page.evaluate(()=>{const api=globalThis.__codexWebuiDebug;api.state.active.canAcceptDirectInput=true;api.syncTurnSnapshot({id:'stale-turn',status:'inProgress',items:[]});window.__noActiveSteer=true;window.__fallbackCallStart=window.__composerRpcCalls.length});
  await page.locator('#prompt').fill('Send after the task ended.');await page.click('#sendButton');
  await page.waitForFunction(()=>document.querySelector('[data-item-id="fallback-user"]')||[...document.querySelectorAll('.user-message')].some(node=>node.textContent==='Send after the task ended.'&&node.parentElement.dataset.optimisticUser===undefined));
  const fallback=await page.evaluate(()=>({calls:window.__composerRpcCalls.slice(window.__fallbackCallStart).filter(call=>['turn/steer','turn/start'].includes(call.method)),messages:[...document.querySelectorAll('.user-message')].filter(node=>node.textContent==='Send after the task ended.').map(node=>({turn:node.parentElement.dataset.userTurnId,steer:node.parentElement.dataset.steer,inTimeline:Boolean(node.closest('.turn-event-stream'))})),draft:document.querySelector('#prompt').value}));
  assert.deepEqual(fallback.calls.map(call=>call.method),['turn/steer','turn/start']);
  assert.equal(fallback.calls[1].params.input[0].text,'Send after the task ended.');
  assert.deepEqual(fallback.messages,[{turn:'fallback-turn',steer:undefined,inTimeline:false}]);assert.equal(fallback.draft,'');
  await page.evaluate(()=>window.__noActiveSteer=false);
  await page.evaluate(()=>{const api=globalThis.__codexWebuiDebug;api.state.active={id:'external-thread',name:'External thread',cwd:api.state.config.defaultCwd,turns:[],canAcceptDirectInput:null};api.syncTurnSnapshot({id:'external-turn',status:'inProgress',itemsView:'full',items:[]});window.__composerConflictMode=true;window.__composerConflictCallStart=window.__composerRpcCalls.length});
  await page.locator('#prompt').fill('Keep this message when the CLI owns the task.');
  await page.click('#sendButton');
  await page.waitForFunction(()=>document.querySelector('#prompt')?.value==='Keep this message when the CLI owns the task.'&&[...document.querySelectorAll('.persistent-error-body p')].some(node=>node.textContent.includes('another Codex app or CLI')));
  const conflict=await page.evaluate(()=>({input:document.querySelector('#prompt')?.value,persistentError:[...document.querySelectorAll('.persistent-error-body p')].find(node=>node.textContent.includes('another Codex app or CLI'))?.textContent?.trim(),activeId:globalThis.__codexWebuiDebug.state.active?.id,calls:window.__composerRpcCalls.slice(window.__composerConflictCallStart).map(call=>call.method),mode:document.querySelector('#sendButton')?.dataset.submitMode}));
  const result={ime,stop,steer,mobile,repeated,pending,afterSteer,echoed,rejected,interrupt,send,conflict,errors};
  console.log(JSON.stringify(result,null,2));
  if(!ime.autocompleteUnchanged||!ime.autocompleteWorks||ime.scenarios.some(test=>test.composingPrevented||test.legacyPrevented||test.nativePrevented||test.keptText!=='拼音输入'||test.imeSubmissions||test.shiftSubmissions||!test.enterPrevented||test.enterSubmissions!==1)||mobile.overflow||mobile.left<0||mobile.right>390||repeated!==2||pending.text!=='Change direction while this task is running.'||pending.delivery!=='sending'||pending.status!=='Steer · Sending…'||echoed.count!==1||echoed.status!=='Steer · Sent'||echoed.optimistic||rejected.count!==2||!rejected.texts.includes('Rejected steering message.')||errors.length||stop.mode!=='stop'||stop.title!=='Stop'||stop.turnId!=='composer-turn'||!stop.stopped||!stop.square||steer.mode!=='steer'||steer.title!=='Steer'||steer.label!==''||steer.stopped||!steer.arrow||afterSteer.input!==''||afterSteer.mode!=='stop'||afterSteer.call?.params?.threadId!=='composer-thread'||afterSteer.call?.params?.expectedTurnId!=='composer-turn'||afterSteer.call?.params?.input?.[0]?.text!=='Change direction while this task is running.'||interrupt.mode!=='stop'||interrupt.call?.params?.threadId!=='composer-thread'||interrupt.call?.params?.turnId!=='composer-turn'||send.mode!=='send'||send.title!=='Send message'||send.stopped||!send.arrow||conflict.input!=='Keep this message when the CLI owns the task.'||conflict.persistentError!=='This task is currently running in another Codex app or CLI. Close it there, then try again.'||conflict.activeId!=='external-thread'||JSON.stringify(conflict.calls)!==JSON.stringify(['thread/resume'])||conflict.mode!=='steer')process.exitCode=1;
}finally{
  await browser?.close();
  server.kill();
  await server.exited;
}
