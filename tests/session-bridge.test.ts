import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';

async function waitFor(check:()=>any){for(let i=0;i<400;i++){const value=await check();if(value)return value;await Bun.sleep(25)}throw new Error('Bridge test timed out')}

test('pending approvals replay over WS/SSE and only one client answer reaches Codex',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'session-bridge-'));
  const sockets:WebSocket[]=[];
  let proc:any,reader:any;
  try{
    // Deterministic app-server fixture: count answers instead of executing a command.
    writeFileSync(join(dir,'codex'),`#!${process.execPath}
import { createInterface } from 'node:readline';
let answers=0,queueStarts=0,queued=false,goalEdit=null,goalSet=null;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.id===901&&!m.method){answers++;return}
 if(!m.method||m.id===undefined)return;
 if(m.method==='thread/start'){
  send({method:'item/started',params:{threadId:'A',turnId:'turn-A',item:{type:'userMessage',content:[{type:'text',text:'/goal resume'}]}}});
  send({method:'goal/status/changed',params:{threadId:'A',goalId:'goal-A',status:'active',objective:'Bridge Goal'}});
  send({id:901,method:'item/commandExecution/requestApproval',params:{threadId:'A',turnId:'turn-A',command:'echo A'}});
  send({id:m.id,result:{thread:{id:'A',cwd:${JSON.stringify(dir)}}}});
 }else if(m.method==='turn/interrupt'){
  queued=true;
  send({method:'turn/completed',params:{threadId:'A',turn:{id:'turn-A',status:'interrupted'}}});
  send({id:m.id,result:{}});
 }else if(m.method==='thread/queue/list')send({id:m.id,result:{data:queued?[{id:'queued-A'}]:[]}});
 else if(m.method==='thread/queue/start'){
  if(m.params.threadId!=='A'||m.params.queuedSubmissionId!=='queued-A')throw new Error('Wrong queued submission');
  queueStarts++;queued=false;send({id:m.id,result:{}});
 }else if(m.method==='thread/goal/set'){goalEdit=m.params;goalSet=m.params;send({id:m.id,result:{goal:{threadId:'A',objective:m.params.objective||'Existing goal',status:m.params.status||'blocked'}}})}
 else if(m.method==='thread/goal/clear'){goalSet=m.params;send({id:m.id,result:{cleared:true}})}
 else if(m.method==='thread/read')send({id:m.id,result:{thread:{id:'A',answers,queueStarts,goalEdit,goalSet,status:{type:'idle'},turns:[]}}});
 else send({id:m.id,result:{}});
});
`,{mode:0o755});
    const port=await new Promise<number>(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const port=(probe.address() as any).port;probe.close(()=>resolve(port))})});
    const base=`http://127.0.0.1:${port}`;
    proc=Bun.spawn(['bun','run','server.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,CODEX_WEBUI_APP_SERVER_MODE:'isolated',PATH:`${dir}:${process.env.PATH}`,HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_PASSWORD:'',CODEX_WEBUI_ACCESS_TOKEN:'bridge-test'},stdout:'ignore',stderr:'ignore'});
    const headers={authorization:`Basic ${Buffer.from('codex:bridge-test').toString('base64')}`};
    await waitFor(async()=>{try{return (await fetch(`${base}/api/health`,{headers})).ok}catch{return false}});
    async function connect(){
      const messages:any[]=[];
      const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers});sockets.push(ws);
      ws.on('message',raw=>messages.push(JSON.parse(String(raw))));
      await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
      return {ws,messages};
    }
    const first=await connect();
    await waitFor(()=>first.messages.some(m=>m.type==='bridge/status'&&m.status==='connected'));
    first.ws.send(JSON.stringify({type:'rpc',id:1,method:'thread/start',params:{}}));
    await waitFor(()=>first.messages.some(m=>m.type==='codex/request'&&m.payload.id===901));
    expect(first.messages.some(m=>m.type==='codex/notification'&&m.payload?.method==='goal/status/changed'&&m.payload.params?.goalId==='goal-A')).toBe(true);
    await waitFor(async()=>{const result=await fetch(`${base}/api/rpc`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({type:'rpc',id:11,method:'thread/read',params:{threadId:'A'}})}).then(r=>r.json());return result.result?.thread?.goalSet?.status==='active'});
    const second=await connect();
    await waitFor(()=>second.messages.some(m=>m.type==='codex/request'&&m.payload.params.threadId==='A'));
    const events=await fetch(`${base}/api/events`,{headers});reader=events.body!.getReader();
    let stream='';
    while(!stream.includes('codex/request'))stream+=new TextDecoder().decode((await reader.read()).value);
    expect(stream).toContain('"threadId":"A"');
    first.ws.send(JSON.stringify({type:'codex/response',requestId:901,result:{decision:'accept'}}));
    await waitFor(()=>second.messages.some(m=>m.payload?.method==='serverRequest/resolved'&&m.payload.params.requestId===901));
    second.ws.send(JSON.stringify({type:'codex/response',requestId:901,result:{decision:'decline'}}));
    second.ws.send(JSON.stringify({type:'rpc',id:2,method:'thread/read',params:{threadId:'A'}}));
    const result=await waitFor(()=>second.messages.find(m=>m.type==='rpc/result'&&m.id===2));
    expect(result.result.thread.answers).toBe(1);
    const third=await connect();
    third.ws.send(JSON.stringify({type:'ping'}));
    await waitFor(()=>third.messages.some(m=>m.type==='pong'));
    expect(third.messages.some(m=>m.type==='codex/request')).toBe(false);
    // Queue recovery runs in the bridge after every browser disconnects.
    await reader.cancel();reader=null;
    for(const socket of sockets)socket.close();
    const rpc=async(method:string,params:any)=>{
      const response=await fetch(`${base}/api/rpc`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({type:'rpc',id:10,method,params})});
      return (await response.json()).result;
    };
    await rpc('turn/interrupt',{threadId:'A',turnId:'turn-A'});
    const recovered=await waitFor(async()=>{const result=await rpc('thread/read',{threadId:'A'});return result.thread.queueStarts===1&&result});
    expect(recovered.thread.queueStarts).toBe(1);
    const edited=await rpc('thread/goal/set',{threadId:'A',objective:' New target ',status:'active',tokenBudget:123});
    expect(edited.goal).toMatchObject({objective:'New target',status:'blocked'});
    const goalEdit=(await rpc('thread/read',{threadId:'A'})).thread.goalEdit;
    expect(goalEdit).toEqual({threadId:'A',objective:'New target',origin:'user'});
  }finally{
    await reader?.cancel();for(const socket of sockets)socket.close();
    proc?.kill();if(proc)await proc.exited;rmSync(dir,{recursive:true,force:true});
  }
},20_000);
