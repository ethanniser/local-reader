const $=id=>document.getElementById(id);
let draft,pairing,busy=false,editTimer;
function placement(){const edited=draft&&$('text').value!==draft.payload.text;$('image-placement').textContent=edited?'Text has been edited; images will be placed after the article.':'Images keep their original positions unless you edit the text.';}
async function persistEdits(){if(!draft||busy)return;await ReaderDrafts.saveEdits(draft.id,{title:$('title').value,text:$('text').value,tags:$('tags').value,includeImages:$('include-images').checked});}
for(const id of ['title','text','tags','include-images'])$(id).addEventListener('input',()=>{placement();clearTimeout(editTimer);editTimer=setTimeout(()=>persistEdits().catch(()=>{$('status').textContent='Your edits could not be saved locally. Keep this tab open until you save to your library.';}),300);});
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).catch(()=>{});
async function refreshPairing(){const result=await chrome.storage.local.get('pairing');pairing=result.pairing?ReaderCloud.config(result.pairing):null;$('pairing-note').hidden=!!pairing;}
async function init(){
 const id=new URL(location.href).searchParams.get('draft');if(!id||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new Error('This draft link is invalid. Capture the article again.');
 draft=await ReaderDrafts.get(id);if(!draft)throw new Error('This draft has expired or was discarded. Capture the article again.');
 $('title').value=draft.edits?.title??draft.payload.title;$('text').value=draft.edits?.text??draft.payload.text;$('tags').value=draft.edits?.tags??(draft.tags||[]).join(',');$('include-images').checked=draft.edits?.includeImages??true;placement();
 $('source').textContent=draft.payload.source;
 const images=(draft.payload.images||[]).slice(0,20);$('image-section').hidden=!images.length;$('image-count').textContent=`Include ${images.length} article image${images.length===1?'':'s'}`;
 for(const image of images){let node;try{const src=ReaderCloud.imageURL(image.src);if(src.startsWith('data:')){node=document.createElement('img');node.src=src;node.alt=image.alt||'Article image';}}catch{}
  if(!node){node=document.createElement('div');node.className='image-placeholder';node.textContent=image.alt||'Image from article';}$('images').append(node);}
 await refreshPairing();$('save').disabled=false;$('status').textContent='Ready to review. Nothing has been uploaded yet.';
}
window.addEventListener('focus',()=>refreshPairing().catch(()=>{}));
$('discard').addEventListener('click',async()=>{if(!draft||busy)return;await ReaderDrafts.remove(draft.id);$('review-form').hidden=true;$('status').textContent='Draft discarded. No article was uploaded.';});
$('review-form').addEventListener('submit',async event=>{
 event.preventDefault();if(busy||!draft)return;clearTimeout(editTimer);
 if(!pairing){$('pairing-note').hidden=false;$('status').textContent='Connect your library before saving.';return;}
 let document;
 try{document=ReaderCloud.article(draft,$('title').value,$('text').value,$('tags').value);}catch(error){$('status').textContent=error.message;return;}
 const textEdited=$('text').value!==draft.payload.text;
 const savePair=ReaderCloud.config(pairing);
 const images=$('include-images').checked?(draft.payload.images||[]).slice(0,20):[];
 const origins=[...new Set(images.map(image=>ReaderCloud.imageOrigin(image.src)).filter(Boolean))];
 // This request remains directly in the Save user gesture. Permissions are only
 // for original image sites; the library token is never sent to those sites.
 const permissions=origins.length?chrome.permissions.request({origins}):Promise.resolve(true);
 busy=true;$('save').disabled=true;$('discard').disabled=true;$('status').textContent='Saving your article…';
 try{
  const granted=await permissions;
  const uploaded=[];let skipped=0;
  for(let i=0;i<images.length;i++){
   $('status').textContent=`Copying article image ${i+1} of ${images.length}…`;
   const image=images[i];
   if(!granted&&ReaderCloud.imageOrigin(image.src)){skipped++;continue;}
   try{uploaded.push(await ReaderCloud.uploadImage(savePair,image));}
   catch(error){if(/Pairing was rejected/.test(error.message))throw error;skipped++;}
  }
  document.images=uploaded.map(image=>({...image,position:textEdited?document.words.length:Math.max(0,Math.min(document.words.length,Math.floor(image.position||0)))}));
  $('status').textContent='Saving to your library…';
  const receipt=await ReaderCloud.request(savePair,'/documents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(document)});
  if(receipt?.deleted===true||receipt?.document?.deleted===true)throw new Error('This article was deleted. Capture the page again to import a new copy.');
  await ReaderDrafts.remove(draft.id);$('review-form').hidden=true;
  $('status').textContent='Saved to your library. It will appear on your paired devices when they sync.'+(skipped?`\n${skipped} image${skipped===1?' could':'s could'} not be copied; the article text was saved.`:'');
 }catch(error){$('status').textContent=error.message||'Could not save. Your draft is still here; try again.';$('save').disabled=false;$('discard').disabled=false;}
 finally{busy=false;}
});
init().catch(error=>{$('status').textContent=error.message||'Could not open this draft.';});
