const button=document.getElementById('send'),status=document.getElementById('status');
const idleMessage='Images are included. Nothing is imported until you click Import this page.';
let currentImport=null, previousImport=null, requestId=null, activeId=null, importRevision=0, busy=false, imagesDenied=false;
function controls(prefix,state){
 const retry=document.getElementById(prefix+'retry');
 retry.hidden=!state||(!['error','paused'].includes(state.status)&&!(state.status==='saved'&&state.skipped>0&&!state.missingOrigins?.length));
 retry.textContent=state?.status==='paused'?'Resume import':state?.status==='saved'?'Retry images':'Retry import';
 document.getElementById(prefix+'allow-images').hidden=state?.status!=='saved'||!state?.missingOrigins?.length;
}
function showCurrent(state){
 currentImport=state;
 busy=!!state&&['queued','uploading'].includes(state.status);
 button.disabled=busy;
 status.textContent=state?.message||idleMessage;
 if(imagesDenied&&state)status.textContent+=' Image access was not granted; some images may be missing.';
 status.classList.toggle('error',state?.status==='error');
 controls('',state);
}
function showPrevious(state){
 previousImport=state;
 document.getElementById('previous-import').hidden=!state;
 document.getElementById('previous-title').textContent=state?.title||'An earlier article';
 document.getElementById('previous-status').textContent=state?.message||'';
 document.getElementById('previous-status').classList.toggle('error',state?.status==='error');
 controls('previous-',state);
}
function receiveImport(state){
 if(!state){showPrevious(null);return;}
 if((requestId&&state.requestId===requestId)||(activeId&&state.id===activeId)){
  activeId=state.id;showCurrent(state);
  if(previousImport?.id===state.id)showPrevious(null);
 }else showPrevious(state);
}
async function send(){
 if(busy)return;
 ++importRevision;busy=true;button.disabled=true;requestId=crypto.randomUUID();activeId=null;currentImport=null;imagesDenied=false;
 controls('',null);status.classList.remove('error');status.textContent='Preparing this import…';
 // Request image access in this direct click gesture, before async capture.
 // Declining still permits text and images readable through the page itself.
 const tabPromise=chrome.tabs.query({active:true,currentWindow:true});
 let permission;try{permission=chrome.permissions.request({origins:['https://*/*','http://*/*']});}catch{permission=Promise.resolve(false);}
 const clickedRequest=requestId;
 try{
  const[granted,tabs]=await Promise.all([Promise.resolve(permission).catch(()=>false),tabPromise]);
  imagesDenied=!granted;
  const[tab]=tabs;
  status.textContent='Capturing this article…';
  const result=await chrome.runtime.sendMessage({type:'send-page',tabId:tab?.id,requestId:clickedRequest});
  if(!result?.ok)throw new Error(result?.error||'Could not import this page.');
  if(requestId!==clickedRequest)return;
  activeId=result.id;
  if(!currentImport&&previousImport?.id===result.id){showCurrent(previousImport);showPrevious(null);}
  if(!currentImport)showCurrent({id:result.id,requestId:clickedRequest,status:'uploading',message:'Importing this page…'});
 }catch(error){if(requestId!==clickedRequest)return;busy=false;status.textContent=error.message;status.classList.add('error');button.disabled=false;}
}
button.addEventListener('click',()=>void send());
function bindActions(prefix,getState){
 document.getElementById(prefix+'retry').addEventListener('click',async()=>{
  const state=getState();if(!state)return;++importRevision;
  const target=document.getElementById(prefix?'previous-status':'status');
  try{const result=await chrome.runtime.sendMessage({type:'retry-import',id:state.id});if(!result?.ok)target.textContent=result?.error||'Could not retry import.';}catch(error){target.textContent=error.message;}
 });
 document.getElementById(prefix+'allow-images').addEventListener('click',async()=>{
  const state=getState();if(!state?.missingOrigins?.length)return;++importRevision;
  const target=document.getElementById(prefix?'previous-status':'status');
  try{
   const granted=await chrome.permissions.request({origins:state.missingOrigins});
   if(granted){const result=await chrome.runtime.sendMessage({type:'retry-import',id:state.id});if(!result?.ok)target.textContent=result?.error||'Could not retry images.';}
  }catch(error){target.textContent=error.message;}
 });
}
bindActions('',()=>currentImport);bindActions('previous-',()=>previousImport);
showCurrent(null);showPrevious(null);
const initialImportRevision=importRevision;
chrome.runtime.sendMessage({type:'inspect-import'}).then(result=>{if(result?.ok&&importRevision===initialImportRevision)showPrevious(result.state);}).catch(()=>{});

const connection = document.getElementById('connection');
const connectionLabel = document.getElementById('connection-label');
const connectionDetail = document.getElementById('connection-detail');
const connectionLink = document.getElementById('connection-link');
let connectionCheck = 0;
function showConnection(state, label, detail, link) {
  connection.dataset.state = state;
  connectionLabel.textContent = label;
  connectionDetail.textContent = detail;
  connectionLink.textContent = link;
}
async function refreshConnection() {
  const check = ++connectionCheck;
  showConnection('checking', 'Checking connection…', 'Checking your saved library connection.', 'Library settings →');
  let pairing;
  try {
    const saved = await chrome.storage.local.get('pairing');
    if (check !== connectionCheck) return;
    if (!saved.pairing) {
      showConnection('disconnected', 'Not connected', 'Connect once to save articles to your library.', 'Connect library →');
      return;
    }
    try { pairing = ReaderCloud.config(saved.pairing); }
    catch {
      showConnection('disconnected', 'Reconnect your library', 'Your saved pairing needs to be replaced.', 'Reconnect library →');
      return;
    }
    showConnection('checking', 'Checking connection…', new URL(pairing.url).hostname, 'Manage connection →');
    await ReaderCloud.request(pairing, '/sync', {}, (url, options) => fetch(url, {...options, signal: AbortSignal.timeout(8000)}));
    if (check !== connectionCheck) return;
    showConnection('connected', 'Connected to your library', new URL(pairing.url).hostname, 'Manage connection →');
  } catch (error) {
    if (check !== connectionCheck) return;
    if (/Pairing was rejected/.test(error.message || '')) {
      showConnection('disconnected', 'Reconnect your library', 'Your pairing is no longer accepted.', 'Reconnect library →');
    } else {
      showConnection('unavailable', 'Connection unavailable', pairing ? 'Your pairing is saved. You can still capture a draft and save it when connected.' : 'Could not read your saved connection. Try reopening the extension.', 'Library settings →');
    }
  }
}
chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pairing) void refreshConnection();
  if(area==='local'&&changes.lastImport){++importRevision;receiveImport(changes.lastImport.newValue);}
});
void refreshConnection();
