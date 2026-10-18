import { test, expect } from 'bun:test';
import { createConversationHistory } from '../conversation-history-service.js';
import { mergeConversationHistory } from '../public/ui-core.js';

const fixture=(count=250)=>({id:'A',path:'/unused',turns:[{id:'turn',status:'inProgress',items:Array.from({length:count},(_,index)=>({id:`item-${index}`,type:'agentMessage',text:`message ${index}`}))}]});
test('bounded history pages and unchanged versions avoid rereads and preserve chronology',async()=>{
 let thread=fixture(),reads=0,stamp='one';
 const service=createConversationHistory({readThread:async()=>{reads++;return structuredClone(thread)},fingerprint:()=>stamp});
 const first=await service.read({threadId:'A'});
 expect(first.history.turns[0].items.length).toBe(100);expect(first.history.turns[0].items[0].id).toBe('item-150');
 let local=mergeConversationHistory(null,first);
 const unchanged=await service.read({threadId:'A',...local.history});
 expect(unchanged.history.mode).toBe('delta');expect(unchanged.history.turns).toEqual([]);expect(reads).toBe(1);
 const older=await service.read({threadId:'A',cursor:first.history.nextCursor});
 local=mergeConversationHistory(local,older,{page:true});
 expect(local.turns[0].items.length).toBe(200);expect(local.turns[0].items[0].id).toBe('item-50');expect(local.history.revision).toBe(first.history.revision);
 thread.turns[0].items[249].text='updated';thread.turns[0].items.push({id:'item-250',type:'agentMessage',text:'new'});thread.turns[0].status='completed';stamp='two';
 const delta=await service.read({threadId:'A',revision:local.history.revision,oldestItemId:local.history.oldestItemId});
 expect(delta.history.mode).toBe('delta');expect(delta.history.turns[0].items.map(item=>item.id)).toEqual(['item-249','item-250']);
 local=mergeConversationHistory(local,delta);expect(local.turns[0].items.length).toBe(201);expect(local.turns[0].status).toBe('completed');expect(local.turns[0].items.at(-2)?.text).toBe('updated');
 const finalPage=await service.read({threadId:'A',cursor:local.history.nextCursor});local=mergeConversationHistory(local,finalPage,{page:true});
 expect(local.turns[0].items.length).toBe(251);expect(local.history.nextCursor).toBeNull();
});
test('deleted items, invalidation and large change bursts remain bounded',async()=>{
 let thread=fixture();const service=createConversationHistory({readThread:async()=>structuredClone(thread),fingerprint:()=>1});
 const first=await service.read({threadId:'A'});thread.turns[0].items.splice(200,1);service.invalidate('A');
 const delta=await service.read({threadId:'A',revision:first.history.revision,oldestItemId:first.history.oldestItemId});
 expect(delta.history.removedItemIds).toEqual(['turn:item-200']);expect(mergeConversationHistory(mergeConversationHistory(null,first),delta).turns[0].items.length).toBe(99);
 thread.turns[0].items.push(...Array.from({length:200},(_,i)=>({id:`new-${i}`,type:'agentMessage',text:'new'})));service.invalidate('A');
 const burst=await service.read({threadId:'A',revision:delta.history.revision,oldestItemId:delta.history.oldestItemId});
 expect(burst.history.mode).toBe('snapshot');expect(burst.history.turns[0].items.length).toBe(100);
 await expect(service.read({threadId:'A',limit:1000})).rejects.toThrow('History limit');
});
test('a refreshed snapshot does not discard already loaded older pages',()=>{
 const previous={id:'A',turns:[{id:'turn',items:Array.from({length:200},(_,index)=>({id:`item-${index}`}))}],history:{revision:'old',oldestItemId:'turn:item-0',nextCursor:null,totalItems:200}};
 const refreshed={thread:{id:'A'},history:{mode:'snapshot',revision:'new',oldestItemId:'turn:item-100',nextCursor:'turn:item-100',totalItems:200,turns:[{id:'turn',historyOrder:0,items:Array.from({length:100},(_,index)=>({id:`item-${index+100}`}))}]}};
 const merged=mergeConversationHistory(previous,refreshed);
 expect(merged.turns[0].items).toHaveLength(200);expect(merged.history.oldestItemId).toBe('turn:item-0');
});
