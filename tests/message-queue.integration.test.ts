import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createQueueRecovery } from '../message-queue-service.js';

for (const interrupted of [false, true]) test(`queue advances without a browser after ${interrupted ? 'interruption' : 'completion'}`, async()=>{
  const home=mkdtempSync(join(tmpdir(),'codex-webui-queue-test-'));
  const responses:any[]=[],events:any[]=[],pending=new Map<number,any>();let seq=0,child:any;
  // Hold inference locally so the test does not contact a model provider.
  const provider=createServer((req,res)=>{
    if(!req.url?.endsWith('/responses')){res.writeHead(404).end();return}
    req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();responses.push(res)});
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{
    const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout: ${method}`))},8000);
    pending.set(id,{resolve:(result:any)=>{clearTimeout(timer);resolve(result)},reject:(error:any)=>{clearTimeout(timer);reject(error)}});
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const recoveryErrors:Error[]=[];
  const recover=createQueueRecovery(rpc,(error:Error)=>recoveryErrors.push(error));
  const wait=async(check:()=>boolean)=>{const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for native queue');await Bun.sleep(20)}};
  try{
    const port=(provider.address() as any).port;
    child=spawn('codex',['app-server','--stdio','-c','model_provider="queue_test"','-c','model="mock"','-c','model_providers.queue_test.name="Queue test"','-c',`model_providers.queue_test.base_url="http://127.0.0.1:${port}"`,'-c','model_providers.queue_test.wire_api="responses"','-c','model_providers.queue_test.requires_openai_auth=false'],{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','ignore']});
    createInterface({input:child.stdout}).on('line',line=>{
      const message=JSON.parse(line),request=pending.get(message.id);
      if(request){pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result)}else {events.push(message);if(interrupted&&message.method==='turn/completed')void recover(message.params.threadId);}
    });
    await rpc('initialize',{clientInfo:{name:'queue-test',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');
    const {thread}=await rpc('thread/start',{cwd:'/tmp',model:'mock'});
    await rpc('turn/start',{threadId:thread.id,input:[{type:'text',text:'First message'}]});await wait(()=>responses.length===1);
    const add=(clientUserMessageId:string,text:string)=>rpc('thread/queue/add',{threadId:thread.id,clientUserMessageId,input:[{type:'text',text}]});
    const first=await add('queued-next','Next message'),cancelled=await add('queued-cancel','Cancelled message');
    expect((await rpc('thread/queue/list',{threadId:thread.id})).data.map((item:any)=>item.id)).toEqual([first.queuedSubmission.id,cancelled.queuedSubmission.id]);
    await rpc('thread/queue/delete',{threadId:thread.id,queuedSubmissionId:cancelled.queuedSubmission.id});
    expect((await rpc('thread/queue/list',{threadId:thread.id})).data.length).toBe(1);
    if(interrupted)await rpc('turn/interrupt',{threadId:thread.id,turnId:events.find(event=>event.method==='turn/started').params.turn.id});
    else responses[0].end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'first-response',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}})+'\n\n');
    await wait(()=>events.some(event=>event.method==='item/started'&&event.params?.item?.clientId==='queued-next'));
    expect(recoveryErrors).toEqual([]);
    expect(events.filter(event=>event.method==='turn/started').length).toBe(2);
    expect((await rpc('thread/queue/list',{threadId:thread.id})).data).toEqual([]);
    const echo=events.find(event=>event.method==='item/started'&&event.params?.item?.clientId==='queued-next');
    expect(echo.params.item.content[0].text).toBe('Next message');
    expect(events.some(event=>event.params?.item?.clientId==='queued-cancel')).toBe(false);
  }finally{
    for(const request of pending.values())request.reject(new Error('Test completed'));pending.clear();
    if(child){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await exit}
    provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));
    rmSync(home,{recursive:true,force:true});
  }
},25000);
