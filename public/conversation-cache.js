import { threadLastActivityAt } from './ui-core.js';

const DATABASE='codex-webui-conversations-v1',STORE='entries',SIDEBAR='__sidebar__';
export const CONVERSATION_CACHE_TTL_MS=48*60*60*1000;
export function isConversationCacheExpired(thread,{now=Date.now(),cachedAt=now}={}){
  return now-(threadLastActivityAt(thread)*1000||cachedAt)>=CONVERSATION_CACHE_TTL_MS;
}

// IndexedDB keeps chat text off the synchronous localStorage/render path.
export function createConversationCache({indexedDB,maxThreads=8,maxItems=100}={}){
  try{indexedDB??=globalThis.indexedDB}catch{}
  let databasePromise,lastWrite=0;
  const removed=new Set();
  function expired(entry,now){return entry.id!==SIDEBAR&&isConversationCacheExpired(entry.thread,{now,cachedAt:entry.activityAt||entry.updatedAt})}
  function pruneEntries(store,now,set=()=>{}){
    const request=store.getAll();
    request.onsuccess=()=>{
      const entries=[],evicted=[];
      for(const entry of request.result){if(entry.id===SIDEBAR)continue;if(expired(entry,now)){store.delete(entry.id);evicted.push(entry.id)}else entries.push(entry)}
      entries.sort((a,b)=>b.updatedAt-a.updatedAt);
      for(const entry of entries.slice(maxThreads)){store.delete(entry.id);evicted.push(entry.id)}
      set(evicted);
    };
  }
  function database(){
    if(!indexedDB)return Promise.resolve(null);
    return databasePromise??=new Promise(resolve=>{
      let request;
      try{request=indexedDB.open(DATABASE,1)}catch{resolve(null);return}
      request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'id'});
      request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();databasePromise=null};resolve(request.result)};
      request.onerror=()=>resolve(null);request.onblocked=()=>resolve(null);
    });
  }
  async function transaction(mode,action){
    try{const db=await database();if(!db)return null;
      return await new Promise(resolve=>{const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);let result=null;action(store,value=>result=value);tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>resolve(null)});
    }catch{return null}
  }
  function compact(thread){
    let remaining=maxItems;const turns=[];
    for(let index=(thread.turns||[]).length-1;index>=0&&remaining>0;index--){const turn=thread.turns[index],items=(turn.items||[]).slice(-remaining);if(items.length){turns.unshift({...turn,items});remaining-=items.length}}
    const first=turns[0],oldest=first?.items[0],oldestKey=oldest?`${first.id}:${oldest.id}`:null;
    const truncated=(thread.turns||[]).reduce((count,turn)=>count+(turn.items||[]).length,0)>maxItems;
    return {...thread,turns,...(thread.history?{history:{...thread.history,oldestItemId:oldestKey,nextCursor:truncated?oldestKey:thread.history.nextCursor}}:{})};
  }
  return {
    async get(id){if(removed.has(id))return null;return transaction('readwrite',(store,set)=>{const request=store.get(id);request.onsuccess=()=>{const entry=request.result;if(entry&&expired(entry,Date.now()))store.delete(id);else set(entry?.thread||null)}})},
    async put(thread){if(!thread?.id||removed.has(thread.id))return;
      const value=compact(thread);
      return transaction('readwrite',(store)=>{
        const request=store.get(thread.id);
        request.onsuccess=()=>{
          const now=Date.now(),activityAt=threadLastActivityAt(thread)*1000||request.result?.activityAt||request.result?.updatedAt||now;
          if(removed.has(thread.id)||isConversationCacheExpired(thread,{now,cachedAt:activityAt}))store.delete(thread.id);
          else{lastWrite=Math.max(now,lastWrite+1);store.put({id:thread.id,updatedAt:lastWrite,activityAt,thread:value})}
          pruneEntries(store,now);
        };
      });
    },
    async summaries(){return transaction('readonly',(store,set)=>{const request=store.get(SIDEBAR);request.onsuccess=()=>set(request.result?.threads||[])})},
    async saveSummaries(threads){return transaction('readwrite',store=>store.put({id:SIDEBAR,threads:threads.filter(thread=>!removed.has(thread.id)).slice(0,50).map(({turns,history,...summary})=>summary)}))},
    async prune(){return transaction('readwrite',(store,set)=>pruneEntries(store,Date.now(),set))},
    async remove(id){removed.add(id);return transaction('readwrite',store=>{store.delete(id);const request=store.get(SIDEBAR);request.onsuccess=()=>{if(request.result)store.put({...request.result,threads:request.result.threads.filter(thread=>thread.id!==id)})}})},
    // Drop a stale conversation snapshot without tombstoning the thread. This
    // is used by transport recovery; a successfully refreshed session must be
    // cacheable again, unlike a user-deleted thread.
    async discard(id){if(!id)return;return transaction('readwrite',store=>store.delete(id))},
    async clear(){return transaction('readwrite',store=>store.clear())},
  };
}
