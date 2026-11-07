const $=id=>document.getElementById(id);
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).catch(()=>{});
async function showConnection(){const {pairing}=await chrome.storage.local.get('pairing');$('disconnect').hidden=!pairing;$('connection').textContent=pairing?'Connected to '+ReaderCloud.config(pairing).url:'';}
$('pair-form').addEventListener('submit',async event=>{
 event.preventDefault();$('connect').disabled=true;$('status').textContent='Checking your library…';
 try{const pairing=ReaderCloud.pairing($('pair-link').value);await ReaderCloud.request(pairing,'/sync');await chrome.storage.local.set({pairing});$('pair-link').value='';await showConnection();$('status').textContent='Connected. Open an article and choose Import this page, or retry a pending import below.';}
 catch(error){$('status').textContent=error.message||'Could not connect. Check the pairing link and your connection.';}
 finally{$('connect').disabled=false;}
});
$('disconnect').addEventListener('click',async()=>{await chrome.storage.local.remove('pairing');await showConnection();$('status').textContent='Disconnected. Your saved library is unchanged.';});
showConnection().catch(()=>{$('status').textContent='Saved pairing is invalid. Paste a fresh pairing link.';});

async function showPending(){
 const pending=await ReaderDrafts.pending(),container=$('pending-imports');container.replaceChildren();
 if(!pending.length){container.textContent='No pending imports.';return;}
 for(const item of pending){const row=document.createElement('div'),title=document.createElement('p');title.textContent=item.title;row.append(title);
  const retry=document.createElement('button');retry.textContent=item.missingOrigins.length?'Allow remaining images':item.status==='saved'?'Retry images':'Retry import';retry.onclick=async()=>{
   if(item.missingOrigins.length&&!await chrome.permissions.request({origins:item.missingOrigins}))return;
   const response=await chrome.runtime.sendMessage({type:'retry-import',id:item.id});$('status').textContent=response?.ok?'Import resumed.':response?.error||'Could not retry.';
  };
  const discard=document.createElement('button');discard.className='secondary';discard.textContent='Discard pending draft';discard.disabled=item.status==='uploading';discard.onclick=async()=>{await ReaderDrafts.remove(item.id);await showPending();};
  row.append(retry,discard);container.append(row);
 }
}
void showPending().catch(()=>{$('pending-imports').textContent='Could not load pending imports.';});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.lastImport)void showPending();});
