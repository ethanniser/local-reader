(function(root){
 const database=new Promise((resolve,reject)=>{
  const request=indexedDB.open('local-reader-imports',2);
  request.onupgradeneeded=()=>{for(const name of ['drafts','edits'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'id'});};
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('Could not open local draft storage.'));
 });
 async function run(mode,action,name='drafts'){const db=await database;return new Promise((resolve,reject)=>{
  const tx=db.transaction(name,mode),store=tx.objectStore(name);let result;
  const request=action(store);request.onsuccess=()=>{result=request.result;};
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(new Error('Could not store the article draft.'));
 });}
 root.ReaderDrafts={put:value=>run('readwrite',store=>store.put(value)),
  async get(id){const draft=await run('readonly',store=>store.get(id));return draft?{...draft,edits:await run('readonly',store=>store.get(id),'edits')}:null;},
  saveEdits:(id,edits)=>run('readwrite',store=>store.put({id,...edits}),'edits'),
  async remove(id){await run('readwrite',store=>store.delete(id));await run('readwrite',store=>store.delete(id),'edits');},
  async pending(){const db=await database;return new Promise((resolve,reject)=>{const request=db.transaction('drafts','readonly').objectStore('drafts').openCursor(),result=[];request.onsuccess=()=>{const cursor=request.result;if(!cursor){resolve(result);return;}const draft=cursor.value,job=draft.job;if(job&&(['queued','uploading','error'].includes(job.status)||(job.missingOrigins||[]).length||job.skipped>0))result.push({id:draft.id,title:draft.payload.title,status:job.status,skipped:job.skipped||0,missingOrigins:job.missingOrigins||[]});cursor.continue();};request.onerror=()=>reject(new Error('Could not list pending imports.'));});},
  async prune(){const db=await database;const expired=await new Promise((resolve,reject)=>{
   const tx=db.transaction('drafts','readonly'),request=tx.objectStore('drafts').openCursor(),ids=[];
   request.onsuccess=()=>{const cursor=request.result;if(cursor){const draft=cursor.value,job=draft.job;const pending=job&&(['queued','uploading','error'].includes(job.status)||(job.missingOrigins||[]).length||job.skipped>0);if(!pending&&draft.created<Date.now()-86400000)ids.push(cursor.key);cursor.continue();}else resolve(ids);};request.onerror=()=>reject(new Error('Could not check local drafts.'));
  });for(const id of expired)await this.remove(id);}};
})(globalThis);
