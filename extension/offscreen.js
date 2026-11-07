const running=new Set();
let imageSlots=0;const imageWaiters=[];
async function withImageSlot(work){
 if(imageSlots>=3)await new Promise(resolve=>imageWaiters.push(resolve));else imageSlots++;
 try{return await work();}finally{const next=imageWaiters.shift();if(next)next();else imageSlots--;}
}
async function publish(value){await chrome.runtime.sendMessage({type:'import-progress',...value}).catch(()=>{});}
async function processImport(id,pairing,allowedOrigins){
 if(running.has(id))return;running.add(id);
 let draft;
 try{
  draft=await ReaderDrafts.get(id);if(!draft)throw new Error('Import draft is missing. Capture the page again.');
  async function currentPairing(){
   const current=await chrome.runtime.sendMessage({type:'import-pairing',id});if(!current?.ok)throw new Error(current?.error||'Pairing changed. Retry after reconnecting.');
   const config=ReaderCloud.config(current.pairing);
   const scope=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(config.url+'#'+config.token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
   if(draft.job?.scope&&draft.job.scope!==scope)throw new Error('This pending import belongs to a different library. Capture the article again for this library.');
   return{config,scope};
  }
  const initial=await currentPairing();pairing=initial.config;
  const editing=draft.edits?.text??draft.payload.text;
  const document=draft.job?.document||ReaderCloud.article(draft,draft.edits?.title??draft.payload.title,editing,draft.edits?.tags??'');
  const uploaded=draft.job?.uploaded||{},images=(draft.edits?.includeImages===false?[]:draft.payload.images||[]).slice(0,20);
  draft.job={...draft.job,scope:initial.scope,document,uploaded,status:'uploading'};
  // Snapshot each checkpoint and serialize writes so concurrent completions cannot
  // replace a newer set of receipts with an older IndexedDB transaction.
  let checkpoint=Promise.resolve();
  function persist(){const snapshot=structuredClone(draft);checkpoint=checkpoint.then(()=>ReaderDrafts.put(snapshot));return checkpoint;}
  function orderedImages(){return Object.entries(uploaded).sort((a,b)=>Number(a[0])-Number(b[0])).map(([,image])=>({...image,position:Math.max(0,Math.min(document.words.length,Math.floor(image.position||0)))}));}
  function advanceContent(){document.contentUpdated=Math.max(Date.now()/1000,(document.contentUpdated||0)+0.001);}
  async function saveDocument(){
   pairing=(await currentPairing()).config;
   const receipt=await ReaderCloud.request(pairing,'/documents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(document)});
   if(receipt?.deleted===true||receipt?.document?.deleted===true)throw new Error('This article was deleted. Capture the page again to import a new copy.');
   draft.job.savedOnce=true;await persist();
  }
  document.images=orderedImages();if(draft.job.savedOnce)advanceContent();
  await persist();
  // Make the article readable before copying any image. Retry uses the same id
  // and original metadata/progress clocks, including any checkpointed receipts.
  await saveDocument();
  const missingOrigins=new Set(),pending=[];let skipped=0,completed=Object.keys(uploaded).length,fatal;
  for(let i=0;i<images.length;i++){
   if(uploaded[i])continue;
   const origin=ReaderCloud.imageOrigin(images[i].src);
   if(origin&&!allowedOrigins.includes(origin)){missingOrigins.add(origin);skipped++;continue;}
   pending.push(i);
  }
  const total=completed+pending.length;
  const progress=()=>publish({id,status:'uploading',message:`Article saved. Copying images ${completed}/${total}…`});
  if(pending.length)await progress();
  let cursor=0;
  async function worker(){
   while(!fatal&&cursor<pending.length){
    const i=pending[cursor++];
    await withImageSlot(async()=>{
     if(fatal)return;
     let config;
     // Pairing lookup failures are fatal regardless of their wording.
     try{config=(await currentPairing()).config;}catch(error){fatal=error;return;}
     if(fatal)return;
     try{
      const receipt=await ReaderCloud.uploadImage(config,images[i]);
      if(editing!==draft.payload.text)receipt.position=document.words.length;
      uploaded[i]=receipt;
      try{await persist();}catch(error){fatal=error;return;}
     }catch(error){
      if(/Pairing was rejected|Pairing changed|different library/.test(error.message)){fatal=error;return;}
      skipped++;
     }
     completed++;await progress();
    });
   }
  }
  await Promise.all(Array.from({length:Math.min(3,pending.length)},worker));
  await checkpoint;if(fatal)throw fatal;
  if(pending.length){document.images=orderedImages();advanceContent();await saveDocument();}
  draft.job={...draft.job,status:'saved',savedOnce:true,document,uploaded,skipped,missingOrigins:[...missingOrigins]};await persist();
  await publish({id,status:'saved',message:'Imported to your library.'+(skipped?` ${skipped} image${skipped===1?' was':'s were'} not copied.`:''),missingOrigins:[...missingOrigins],skipped});
 }catch(error){
  if(draft){draft.job={...draft.job,status:'error'};await ReaderDrafts.put(draft).catch(()=>{});}
  await publish({id,status:'error',message:error.message||'Import failed. Retry when connected.'});
 }finally{running.delete(id);}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id||message?.target!=='offscreen')return;
 if(message.type==='inspect-running'){reply({running:running.has(message.id)});return;}
 if(message.type==='process-import'){void processImport(message.id,message.pairing,message.allowedOrigins||[]);reply({ok:true});}
});
