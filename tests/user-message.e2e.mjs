import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { root, launchOptions, artifact } from './browser-runtime.mjs';

// Exercise the real frontend without a Codex process or external account.
const build=await Bun.build({entrypoints:[`${root}/public/app.js`],target:'browser',minify:true});
assert.ok(build.success,build.logs.join('\n'));
const bundle=await build.outputs[0].text();
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request,server){
  const path=new URL(request.url).pathname;
  if(path==='/ws'&&server.upgrade(request))return;
  if(path==='/api/auth/status')return Response.json({authenticated:true});
  if(path==='/api/config')return Response.json({home:'/tmp',defaultCwd:'/tmp'});
  if(path==='/api/projects/visibility')return Response.json({revision:0,hiddenProjects:{}});
  if(path.startsWith('/api/'))return Response.json({entries:[],data:[]});
  if(path==='/app.bundle.js')return new Response(bundle,{headers:{'content-type':'text/javascript'}});
  if(path.startsWith('/vendor/'))return new Response('',{headers:{'content-type':'text/css'}});
  const file=Bun.file(`${root}/public${path==='/'?'/index.html':path}`);
  return await file.exists()?new Response(file):new Response('',{status:404});
},websocket:{message(){}}});
const browser=await chromium.launch(launchOptions());
const results=[];
const message='复制这条消息\n\n保留换行、<标签> 和 `代码`。';
function luminance(value){return value.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0)}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
try{
  for(const scheme of ['light','dark'])for(const mobile of [false,true]){
    const locale=mobile?'zh-CN':'en';
    const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:800},colorScheme:scheme,hasTouch:mobile,permissions:['clipboard-read','clipboard-write']});
    await context.addInitScript(locale=>{if(window===window.top)localStorage.setItem('codex-webui-locale',locale)},locale);
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>globalThis.__codexWebuiDebug);
    await page.evaluate(message=>{
      const api=globalThis.__codexWebuiDebug;
      api.state.active={id:'copy-thread',cwd:'/tmp',turns:[]};
      api.syncTurnSnapshot({id:'copy-turn',status:'completed',items:[{id:'copy-user',type:'userMessage',content:[{type:'text',text:message}]}]});
      window.__clipboard=navigator.clipboard;
    },message);
    const button=page.locator('.user-message-copy').first();
    await button.waitFor({state:'visible'});
    assert.equal(await button.getAttribute('aria-label'),mobile?'复制消息':'Copy message');
    await button.click();
    await page.waitForFunction(()=>document.querySelector('.user-message-copy > span:last-child')?.textContent=== (document.documentElement.lang==='zh-CN'?'已复制':'Copied'));
    assert.equal(await page.evaluate(()=>window.__clipboard.readText()),message);

    const colors=await page.locator('.user-message').first().evaluate(node=>{
      const style=getComputedStyle(node),button=node.parentElement.querySelector('.user-message-copy');
      return {background:style.backgroundColor,border:style.borderColor,text:style.color,surface:getComputedStyle(document.querySelector('#conversation')).backgroundColor,borderWidth:style.borderWidth,overflow:document.documentElement.scrollWidth>innerWidth,buttonBelow:button.getBoundingClientRect().top>=node.getBoundingClientRect().bottom};
    });
    assert.ok(contrast(colors.text,colors.background)>=4.5,'Message text remains readable');
    assert.ok(contrast(colors.background,colors.surface)>=1.15,'Message background stands out from the conversation');
    assert.equal(colors.borderWidth,'1px');
    assert.ok(!colors.overflow&&colors.buttonBelow);

    // The same item can be updated without adding another copy button.
    await page.evaluate(message=>{
      const api=globalThis.__codexWebuiDebug;
      api.notify('item/completed',{threadId:'copy-thread',turnId:'copy-turn',item:{id:'copy-user',type:'userMessage',content:[{type:'text',text:message} ]}});
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
    },message);
    assert.equal(await page.locator('.user-message-copy').count(),1);
    await button.click();
    assert.equal(await page.evaluate(()=>window.__clipboard.readText()),message,'HTTP fallback copies the complete text');
    assert.equal(await page.locator('body > textarea').count(),0);
    assert.ok(await button.evaluate(node=>node===document.activeElement),'Fallback restores focus');

    // Permission rejection also falls back to copying through a selected textarea.
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('Denied'))}}));
    await button.focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.__clipboard.readText()),message);
    await page.waitForFunction(()=>document.querySelector('.user-message-copy > span:last-child')?.textContent===(document.documentElement.lang==='zh-CN'?'复制':'Copy'));

    await page.evaluate(()=>{document.execCommand=()=>false});
    await button.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.persistent-error-body p')].some(node=>node.textContent.includes(document.documentElement.lang==='zh-CN'?'复制失败':'Copy failed')));
    assert.ok(await button.isEnabled());
    assert.equal(await page.locator('body > textarea').count(),0);

    await page.evaluate(()=>{
      const api=globalThis.__codexWebuiDebug;
      api.notify('item/completed',{threadId:'copy-thread',turnId:'file-turn',item:{id:'file-user',type:'userMessage',content:[{type:'text',text:'Attached file: "report.txt"\n/tmp/report.txt'}]}});
      api.notify('item/completed',{threadId:'copy-thread',turnId:'long-turn',item:{id:'long-user',type:'userMessage',content:[{type:'text',text:'long'.repeat(150)}]}});
    });
    assert.equal(await page.locator('.user-message-copy[hidden]').count(),1,'Attachment-only messages have no empty copy action');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:artifact(`user-message-${scheme}-${mobile?'mobile':'desktop'}.png`)});
    assert.deepEqual(errors,[]);
    results.push({scheme,mobile,textContrast:contrast(colors.text,colors.background),surfaceContrast:contrast(colors.background,colors.surface)});
    await context.close();
  }
  console.log(JSON.stringify({copy:'Clipboard API, HTTP fallback, denied permission, keyboard, failure feedback',results},null,2));
}finally{await browser.close();server.stop(true)}
