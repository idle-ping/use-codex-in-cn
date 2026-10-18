import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

export async function waitFor(check) {
  for (let i = 0; i < 400; i++) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error('Project visibility fixture timed out');
}

export async function createProjectVisibilityFixture() {
  // Keep the project inside the application's existing folder-browsing boundary.
  const artifacts = new URL('../.artifacts/', import.meta.url).pathname;
  mkdirSync(artifacts, { recursive: true });
  const dir = mkdtempSync(join(artifacts, 'project-visibility-'));
  const alpha = join(dir, 'alpha'), beta = join(dir, 'beta');
  mkdirSync(alpha); mkdirSync(beta);
  const initial = [
    { id: 'old-alpha', name: 'Old alpha session', cwd: alpha, status: { type: 'idle' }, createdAt: 1, updatedAt: 2, turns: [], canAcceptDirectInput: true },
    { id: 'old-beta', name: 'Old beta session', cwd: beta, status: { type: 'idle' }, createdAt: 1, updatedAt: 2, turns: [], canAcceptDirectInput: true },
    { id: 'tasks', name: 'Task without a project', projectless: true, status: { type: 'idle' }, turns: [] },
  ];
  writeFileSync(join(dir, 'codex'), `#!${process.execPath}
import { createInterface } from 'node:readline';
let count=0;
const threads=${JSON.stringify(initial)};
const queues=new Map();
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line),p=m.params||{};
  if(!m.method||m.id===undefined)return;
  if('webuiProjectless' in p)throw new Error('WebUI metadata leaked into native RPC');
  let result={};
  if(m.method==='initialize')result={codexHome:${JSON.stringify(dir)}};
  else if(m.method==='model/list')result={data:[{id:'gpt-fixture',model:'gpt-fixture',displayName:'GPT Fixture',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
  else if(m.method==='account/read')result={account:null};
  else if(m.method==='thread/list')result={data:threads};
  else if(m.method==='thread/start'){
    if(p.model==='fail'){send({id:m.id,error:{message:'Fixture creation failed'}});return}
    const thread={id:'new-'+(++count),name:'New session '+count,cwd:p.cwd,status:{type:'idle'},createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[],canAcceptDirectInput:true};
    threads.unshift(thread);send({method:'thread/started',params:{thread}});result={thread};
  }else if(m.method==='thread/read'||m.method==='thread/resume'){
    const thread=threads.find(t=>t.id===p.threadId);result={thread};
    if(m.method==='thread/resume')send({method:'thread/started',params:{thread}});
  }else if(m.method==='turn/start'){
    result={turn:{id:'turn-'+(++count),status:'completed',items:[]}};
    send({method:'thread/status/changed',params:{threadId:p.threadId,status:{type:'idle'}}});
  }else if(m.method==='thread/queue/add'){
    const queuedSubmission={id:'queue-'+(++count),clientUserMessageId:p.clientUserMessageId,input:p.input};
    queues.set(p.threadId,[queuedSubmission]);result={queuedSubmission};
  }else if(m.method==='thread/queue/list')result={data:queues.get(p.threadId)||[]};
  else if(m.method==='thread/turns/list'||m.method==='permissionProfile/list')result={data:[]};
  else if(m.method==='host/thread/live')result={active:false,turn:null};
  send({id:m.id,result});
});
`, { mode: 0o700 });
  const port = await new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Basic ${Buffer.from('codex:visibility-test').toString('base64')}` };
  let proc;
  const fixture = {
    dir, alpha, beta, base, headers,
    async start() {
      proc = Bun.spawn(['bun', 'run', 'server.ts'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CODEX_HOME: dir, CODEX_WEBUI_CWD: alpha, CODEX_WEBUI_PROJECTLESS: 'false', HOST: '127.0.0.1', PORT: String(port), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: 'visibility-test' },
        stdout: 'ignore', stderr: 'pipe',
      });
      await waitFor(async () => { try { return (await (await fetch(`${base}/api/health`, { headers })).json()).codex; } catch { return false; } });
    },
    async stop() { if (proc) { proc.kill(); await proc.exited; proc = null; } },
    async dispose() { await fixture.stop(); rmSync(dir, { recursive: true, force: true }); },
    async visibility(body) {
      const response = await fetch(`${base}/api/projects/visibility`, body ? { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    async rpc(method, params = {}) {
      return (await (await fetch(`${base}/api/rpc`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method, params }) })).json());
    },
  };
  try { await fixture.start(); return fixture; }
  catch (error) { await fixture.dispose(); throw error; }
}
