import './style.css';
import QRCode from 'qrcode';
import {formattedWords,wordRun,type ArticleMark} from './formatting';
import {timestampAt,formatTimestamp,type TimelineChunk} from './timeline';

type Book = { id:string; title:string; collection:string; tags:string[]; source:string; unread:boolean; words:number; position:number; updated:number; metadata_updated?:number; content_updated?:number; image_count?:number; read_updated?:number; archived?:boolean; deleted?:boolean; lifecycle_updated?:number };
type ArticleImage = {src:string;alt:string;caption:string;position:number};
type ImportResult = {id:string;warnings?:string[]};
type Doc = Omit<Book,'words'> & { words:string[]; marks?:ArticleMark[]; images?:ArticleImage[]; paragraphs:{start:number;end:number;kind:string}[] };
type Timing = {word:number;start:number;end:number};
type BackendInfo = {id:string;name:string;model:string;available:boolean;status:string;error:string|null;voices:Record<string,string>;timing:string};
type Chunk = {audio:string;start:number;end:number;duration:number;timings:Timing[];cached:boolean;generation_seconds?:number};
type Scheduled = {chunk:Chunk;at:number;until:number;source:AudioBufferSourceNode};
const $ = <T extends HTMLElement=HTMLElement>(id:string) => document.getElementById(id) as T;
const esc = (s:string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const icons = {
 play:'<path d="m9 5 11 7-11 7z"/>',pause:'<path d="M9 5v14M15 5v14"/>',
 book:'<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zm16 0h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3z"/>',
 prev:'<path d="m16 5-7 7 7 7M5 5v14"/>',next:'<path d="m8 5 7 7-7 7M19 5v14"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
 headphones:'<path d="M4 14v-3a8 8 0 0 1 16 0v3M4 13h3v7H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2zm16 0h-3v7h3a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2z"/>',
 upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',
 menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',arrow:'<path d="M7 17 17 7M7 7h10v10"/>'
};
const icon = (name:keyof typeof icons) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

$('app').innerHTML = `
<aside id="sidebar">
 <button id="close-library" class="icon-button" type="button" aria-label="Close library">${icon('close')}</button>
 <div class="brand"><div class="brand-icon">${icon('headphones')}</div><div>local reader<span>A little room for listening.</span></div></div>
 <button id="import" class="add">${icon('plus')} Add something to read</button>
 <label class="search">${icon('search')}<input id="search" type="search" placeholder="Search titles or tags" aria-label="Search titles or tags"></label>
 <div class="library-heading"><span>YOUR LIBRARY</span><span id="book-count"></span></div>
 <div class="filters"><button data-filter="all">All works</button><button data-filter="unread">Unread</button><button data-filter="read">Read</button><button class="selected" data-filter="recent">Recent</button><button data-filter="archived">Archived</button></div>
 <label class="tag-filter-label" for="tag-filter">TAG <select id="tag-filter" aria-label="Filter library by tag"><option value="">All tags</option></select></label>
 <nav id="library" aria-label="Library"></nav>
 <button id="sync-settings" class="local-note sync-settings"><i></i><span>Library sync<small id="sync-label">Checking sync…</small></span></button>
</aside>
<main>
 <header class="topbar"><button id="menu" class="icon-button" aria-label="Toggle library">${icon('menu')}</button><div class="breadcrumb">LIBRARY <span>/</span> <b id="collection">ALL WORKS</b></div><div id="model-status" class="model-status"><i></i> Warming up voice…</div></header>
 <section id="scroll-area"><div class="reading-shell">
  <div class="eyebrow"><span class="chapter-mark">01</span> <span id="doc-label">FROM YOUR LIBRARY</span></div>
  <h1 id="title">Your next good read.</h1>
  <div class="doc-meta"><span id="word-count"></span><span class="dot">·</span><span id="read-time"></span><a id="source" target="_blank" rel="noreferrer">Original ${icon('arrow')}</a></div>
  <div id="read-state" class="read-state" hidden><span id="read-state-label"></span><button id="toggle-read" type="button">Mark as read</button><small>Your listening position stays saved.</small></div>
  <div id="article-tags" class="article-tags" hidden><div id="tag-chips" class="tag-chips" aria-label="Article tags"></div><form id="tags-form"><label for="tags-input">Tags</label><div class="tags-edit-row"><input id="tags-input" type="text" autocomplete="off" placeholder="e.g. philosophy, favorites" aria-describedby="tags-help"><button id="save-tags" type="submit">Save tags</button></div><small id="tags-help">Separate tags with commas. Leave blank to remove all tags.</small><span id="tags-status" role="status" aria-live="polite"></span></form></div>
  <div class="reading-tip"><span>${icon('headphones')} Click any word to listen from there.</span><button id="follow" aria-pressed="true">Follow along <i></i></button></div>
  <div id="timing-note" hidden>Word highlighting is approximate with this engine.</div>
  <article id="text" aria-label="Document text"></article>
  <div id="end-note">A good place to pause.<span>You’ve reached the end of this work.</span></div>
 </div></section>
 <div class="return-bar"><button id="return-current" hidden type="button">${icon('headphones')} Back to reading</button></div>
 <footer class="player">
  <div class="progress-row"><span id="position-label"><span id="position-time">0:00</span><span aria-hidden="true"> · </span><span id="position-percent">0%</span></span><input id="progress" type="range" min="0" max="100" value="0" step="1" aria-label="Reading position"><span id="remaining"></span></div>
  <div class="player-row">
   <div class="now-playing"><div class="mini-cover">${icon('book')}</div><div><b id="playing-title">Choose a work</b><span id="playback-status" aria-live="polite">Ready when you are</span></div></div>
   <div class="transport"><button id="previous" class="icon-button" title="Previous paragraph" aria-label="Previous paragraph">${icon('prev')}</button><button id="play" class="play" aria-label="Play">${icon('play')}</button><button id="next" class="icon-button" title="Next paragraph" aria-label="Next paragraph">${icon('next')}</button></div>
   <div class="voice-controls"><label class="engine-control"><span>ENGINE</span><select id="backend" aria-label="Speech engine"><option value="kokoro">Kokoro</option></select></label><label><span>VOICE</span><select id="voice" aria-label="Voice"><option value="af_heart">Heart · American</option></select></label><div class="speed-control"><span>PACE</span><button id="pace-button" popovertarget="pace-panel" aria-label="Playback speed">1×</button><div id="pace-panel" popover><div class="pace-heading"><b>Your listening pace</b><span>Pitch stays natural</span></div><div class="pace-presets"><button data-speed="1">1×</button><button data-speed="1.5">1.5×</button><button data-speed="2">2×</button></div><div class="pace-slider-row"><span>0.5×</span><input id="speed-slider" aria-label="Playback speed slider" type="range" min="0.5" max="4" step="0.05" value="1"><span>4×</span></div><label class="custom-pace">Custom speed <span><input id="speed-custom" aria-label="Custom playback speed" type="number" min="0.5" max="4" step="0.05" value="1"> ×</span></label></div></div></div>
  </div>
 </footer>
</main>
<dialog id="import-dialog"><div class="modal-top"><span class="eyebrow">GROW YOUR LIBRARY</span><button type="button" id="close-import" class="icon-button" aria-label="Close">${icon('close')}</button></div><h2>What would you like to hear?</h2><p>Add a link, a document, or a passage. Saved on this Mac and synced to your paired devices.</p>
<div class="import-tabs" aria-label="Import method"><button type="button" data-import-tab="link" aria-pressed="true">Link</button><button type="button" data-import-tab="text" aria-pressed="false">Text / file</button><button type="button" data-import-tab="browser" aria-pressed="false">From Chrome</button></div>
<section id="import-link"><form id="link-form"><label for="import-url">Article link</label><input id="import-url" type="url" required maxlength="4096" placeholder="https://…"><p>We’ll fetch the article text. For a page that needs your login, use From Chrome.</p><button class="add submit" type="submit">Import link ${icon('plus')}</button></form></section>
<section id="import-text" hidden><form id="paste-form"><label class="upload-zone">${icon('upload')}<b>Choose a file</b><span>TXT, Markdown, HTML or PDF · up to 20 MB</span><input id="upload" type="file" accept=".txt,.md,.markdown,.html,.htm,.pdf"></label><div class="or">or paste some text</div><input id="paste-title" required maxlength="300" placeholder="Give it a title" aria-label="Document title"><textarea id="paste-text" required maxlength="2000000" placeholder="An essay, a chapter, something worth your attention…" aria-label="Document text"></textarea><input id="paste-source" type="url" maxlength="4096" placeholder="Original link (optional)" aria-label="Original link"><p id="import-images" hidden></p><button type="submit" class="add submit">Add to library ${icon('plus')}</button></form></section>
<section id="import-browser" hidden><p>Bring over an article you can read in Chrome, including pages you’re signed into. Select a passage first to import only that text.</p><ol><li><a href="/api/extension/download" download>Download the Chrome extension</a> and unzip it.</li><li>Open <b>chrome://extensions</b>, enable <b>Developer mode</b>, then <b>Load unpacked</b> and choose the extracted folder.</li><li>Open the extension’s Library settings and connect your library once. On an article, click the extension, then <b>Import this page →</b>. It saves immediately; you can close the popup.</li></ol><p>After updating the extension files, click <b>Reload</b> on its card in <b>chrome://extensions</b>. The extension saves directly to your paired library, even with the Mac app closed. It only reads a page when you ask it to.</p></section>
<div id="import-error" role="alert"></div></dialog>
<dialog id="sync-dialog"><div class="modal-top"><span class="eyebrow">YOUR DEVICES</span><button id="close-sync" class="icon-button" aria-label="Close sync settings">${icon('close')}</button></div><h2>Your library, everywhere.</h2><p id="sync-detail">Checking sync…</p><button id="sync-now" class="add" type="button">Sync now</button><h3>Connect your iPhone</h3><p>Install Local Reader on your iPhone, then scan this code with its camera. Confirm the connection in the app. Keep this pairing code private.</p><canvas id="pairing-code" hidden aria-label="Private device pairing code"></canvas><h3>Connect Chrome</h3><p>Open the extension’s settings and paste this private pairing link.</p><button id="copy-pairing" class="add" type="button" disabled>Copy pairing link</button><p id="pairing-error"></p></dialog><div id="toast" role="status"></div>`;

let pendingImages:ArticleImage[] = [], capturedText = '';
let books:Book[] = [], doc:Doc|null = null, current = 0, filter = 'recent', following = true, selectedTag = '';
let backend = localStorage.getItem('reader-backend') || 'kokoro';
let voice = localStorage.getItem('reader-voice-'+backend) || (backend==='kokoro' ? localStorage.getItem('reader-voice') || 'af_heart' : '');
let backends:BackendInfo[] = [];
let statusTimer:ReturnType<typeof setTimeout>|undefined;
let speed = Math.max(0.5,Math.min(4,Number(localStorage.getItem('reader-speed') || 1))) || 1;
let ready = false, loadId = 0, highlighted:HTMLElement|null = null, lastSave = 0;
let ctx:AudioContext|null = null, playing = false, session = 0, busy = false;
let controller:AbortController|null = null, scheduled:Scheduled[] = [], nextWord = 0;
let timeline:TimelineChunk[] = [], timelineKey='';
let timestampBase:{word:number;point:ReturnType<typeof timestampAt>}|null=null;
let lastFollow = 0;

async function api<T>(url:string, options:RequestInit={}):Promise<T> {
 const response = await fetch(url, options);
 if (!response.ok) {
  let message = `Request failed (${response.status})`;
  try { const data = await response.json(); message = typeof data.detail === 'string' ? data.detail : message; } catch {}
  throw new Error(message);
 }
 return response.json();
}
const json = (body:unknown):RequestInit => ({method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
function toast(message:string) { $('toast').textContent=message; $('toast').classList.add('visible'); setTimeout(()=>$('toast').classList.remove('visible'),5000); }
function status(message:string) { $('playback-status').textContent=message; }
type PendingProgress = {word:number;updated:number};
const pendingProgress=new Map<string,PendingProgress>(), progressRequests=new Set<string>();
function flushProgress(id:string){
 const pending=pendingProgress.get(id);
 if(!pending||progressRequests.has(id))return;
 progressRequests.add(id);
 fetch(`/api/documents/${id}/progress`, {...json({word:pending.word}),method:'PUT',keepalive:true})
  .then(response=>{if(!response.ok)throw new Error('Progress was not saved');if(pendingProgress.get(id)===pending)pendingProgress.delete(id);})
  .catch(()=>{/* Keep this position for the next library refresh/reconnection. */})
  .finally(()=>{progressRequests.delete(id);const next=pendingProgress.get(id);if(next&&next!==pending)flushProgress(id);});
}
function persist() {
 if(!doc)return;
 if(doc.position!==current){
  const updated=Date.now()/1000;
  doc.position=current;doc.updated=updated;
  pendingProgress.set(doc.id,{word:current,updated});
  const book=books.find(b=>b.id===doc!.id);if(book){book.position=current;book.updated=updated;}
  localStorage.setItem('reader-document',doc.id);
  localStorage.setItem('reader-position-'+doc.id,JSON.stringify({word:current,updated}));
 }
 flushProgress(doc.id);
}
const readRequests=new Set<string>();
function renderReadState(){
 $('read-state').hidden=!doc;if(!doc)return;
 $('read-state-label').textContent=doc.unread?'Unread':'Read';
 const button=$<HTMLButtonElement>('toggle-read');
 button.textContent=readRequests.has(doc.id)?'Saving…':doc.unread?'Mark as read':'Mark as unread';
 button.disabled=readRequests.has(doc.id);
}
async function toggleRead(id:string){
 const book=books.find(b=>b.id===id);if(!book||readRequests.has(id)||lifecycleRequests.has(id))return;
 const unread=!Boolean(book.unread);readRequests.add(id);renderReadState();
 try{
  const result=await api<{unread:boolean;read_updated:number}>(`/api/documents/${encodeURIComponent(id)}/read-status`,{...json({unread}),method:'PUT'});
  const saved=books.find(book=>book.id===id);
  if(saved&&result.read_updated>=(saved.read_updated??0)){saved.unread=result.unread;saved.read_updated=result.read_updated;}
  if(doc?.id===id&&result.read_updated>=(doc.read_updated??0)){doc.unread=result.unread;doc.read_updated=result.read_updated;}
  renderLibrary();
 }catch(error){toast((error as Error).message);}
 finally{readRequests.delete(id);renderReadState();}
}
$('toggle-read').onclick=()=>{if(doc)void toggleRead(doc.id);};
type Lifecycle={archived:boolean;deleted:boolean;lifecycle_updated:number};
const lifecycleRequests=new Set<string>(), lifecycleStates=new Map<string,Lifecycle>();
function clearDeletedDocument(id:string){
 pendingProgress.delete(id);localStorage.removeItem('reader-position-'+id);
 if(doc?.id!==id)return;
 ++loadId;stop();doc=null;current=0;highlighted=null;timeline=[];
 localStorage.removeItem('reader-document');
 $('title').textContent='Your next good read.';$('playing-title').textContent='Choose a work';
 for(const key of ['text','word-count','read-time','remaining'])$(key).textContent='';
 $('source').hidden=true;$('return-current').hidden=true;$('end-note').hidden=true;
 $<HTMLInputElement>('tags-input').value='';$<HTMLInputElement>('progress').value='0';
 $('position-time').textContent='0:00';$('position-percent').textContent='0%';
 renderTags();renderReadState();status('Choose a work from your library');
 if('mediaSession' in navigator)navigator.mediaSession.metadata=null;
}
const deleteDialog=document.createElement('dialog');deleteDialog.id='delete-dialog';deleteDialog.setAttribute('aria-labelledby','delete-heading');
deleteDialog.innerHTML='<form method="dialog"><h2 id="delete-heading">Delete this article?</h2><p id="delete-description"></p><div class="delete-actions"><button value="cancel" autofocus>Cancel</button><button value="delete" class="destructive">Delete article</button></div></form>';document.body.append(deleteDialog);
function confirmDelete(title:string):Promise<boolean>{
 if(deleteDialog.open)return Promise.resolve(false);
 $('delete-description').textContent=`“${title}” will be deleted from your library. This cannot be undone.`;deleteDialog.returnValue='cancel';
 return new Promise(resolve=>{deleteDialog.addEventListener('close',()=>resolve(deleteDialog.returnValue==='delete'),{once:true});deleteDialog.showModal();});
}
async function changeLifecycle(id:string,action:'archive'|'delete'){
 const book=books.find(b=>b.id===id);if(!book||lifecycleRequests.has(id)||readRequests.has(id))return;
 if(action==='delete'&&!await confirmDelete(book.title))return;
 if(!books.some(b=>b.id===id)||lifecycleRequests.has(id)||readRequests.has(id))return;
 lifecycleRequests.add(id);
 try{
  const result=await api<Lifecycle>(`/api/documents/${encodeURIComponent(id)}${action==='archive'?'/archive':''}`,action==='archive'?{...json({archived:!book.archived}),method:'PUT'}:{method:'DELETE'});
  const known=lifecycleStates.get(id);const existing=books.find(b=>b.id===id);
  if(result.lifecycle_updated>=Math.max(known?.lifecycle_updated??0,existing?.lifecycle_updated??0)){
   lifecycleStates.set(id,result);if(existing)Object.assign(existing,result);
   if(doc?.id===id)Object.assign(doc,result);
   if(result.deleted){books=books.filter(b=>b.id!==id);clearDeletedDocument(id);}
  }
  renderLibrary();
 }catch(error){toast((error as Error).message);}
 finally{lifecycleRequests.delete(id);}
}
const bookMenu=document.createElement('div');bookMenu.id='book-menu';bookMenu.setAttribute('role','menu');bookMenu.setAttribute('aria-label','Article actions');bookMenu.hidden=true;document.body.append(bookMenu);
let menuBookId:string|null=null;
function closeBookMenu(restoreFocus=false){const id=menuBookId;bookMenu.hidden=true;menuBookId=null;if(restoreFocus&&id)document.querySelector<HTMLElement>(`#library [data-id="${CSS.escape(id)}"]`)?.focus();}
function openBookMenu(button:HTMLElement,x?:number,y?:number){
 const book=books.find(b=>b.id===button.dataset.id);if(!book)return;
 menuBookId=book.id;const disabled=readRequests.has(book.id)||lifecycleRequests.has(book.id);
 bookMenu.innerHTML=`<button role="menuitem" data-action="read" ${disabled?'disabled':''}>${book.unread?'Mark as read':'Mark as unread'}</button><button role="menuitem" data-action="archive" ${disabled?'disabled':''}>${book.archived?'Restore to library':'Archive'}</button><button role="menuitem" data-action="delete" class="destructive" ${disabled?'disabled':''}>Delete…</button>`;
 bookMenu.hidden=false;const rect=button.getBoundingClientRect();
 bookMenu.style.left=Math.max(8,Math.min(x??rect.left,innerWidth-bookMenu.offsetWidth-8))+'px';
 bookMenu.style.top=Math.max(8,Math.min(y??rect.bottom,innerHeight-bookMenu.offsetHeight-8))+'px';
 bookMenu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
bookMenu.addEventListener('click',event=>{const action=(event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;const id=menuBookId;if(!id||!action)return;closeBookMenu(true);if(action==='read')void toggleRead(id);else void changeLifecycle(id,action as 'archive'|'delete');});
bookMenu.addEventListener('keydown',event=>{const items=[...bookMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=items.indexOf(document.activeElement as HTMLButtonElement);if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}if(event.key==='Tab')closeBookMenu();});
document.addEventListener('pointerdown',event=>{if(!bookMenu.contains(event.target as Node))closeBookMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!bookMenu.hidden){event.preventDefault();closeBookMenu(true);}});
window.addEventListener('resize',()=>closeBookMenu());$('library').addEventListener('scroll',()=>closeBookMenu());
function tagsOf(book:Pick<Book,'tags'>):string[]{return Array.isArray(book.tags)?book.tags:[];}
function renderLibrary() {
 const tags=new Map<string,{label:string;count:number}>();
 for(const book of books)for(const tag of new Set(tagsOf(book))){const key=tag.toLocaleLowerCase();const found=tags.get(key);if(found)found.count++;else tags.set(key,{label:tag,count:1});}
 if(selectedTag&&!tags.has(selectedTag))selectedTag='';
 const tagMenu=$<HTMLSelectElement>('tag-filter');
 tagMenu.innerHTML='<option value="">All tags</option>'+[...tags].sort((a,b)=>a[1].label.localeCompare(b[1].label)).map(([key,tag])=>`<option value="${esc(key)}">${esc(tag.label)} (${tag.count})</option>`).join('');
 tagMenu.value=selectedTag;
 const query=$<HTMLInputElement>('search').value.trim().toLocaleLowerCase();
 let list=books.filter(b=>[b.title,...tagsOf(b)].join(' ').toLocaleLowerCase().includes(query)&&(!selectedTag||tagsOf(b).some(tag=>tag.toLocaleLowerCase()===selectedTag))&&(filter!=='unread'||b.unread)&&(filter!=='read'||!b.unread)&&!b.deleted&&(filter==='archived'?Boolean(b.archived):!b.archived));
 list=[...list].sort(filter==='recent'?(a,b)=>Math.max(b.updated,b.content_updated??0)-Math.max(a.updated,a.content_updated??0)||a.title.localeCompare(b.title):(a,b)=>a.title.localeCompare(b.title));
 $('book-count').textContent=list.length===books.length?String(books.length):`${list.length} / ${books.length}`;
 $('library').innerHTML=list.map(b=>`<button class="book ${doc?.id===b.id?'active':''}" data-id="${esc(b.id)}" aria-haspopup="menu" title="Right-click or Alt-click for article actions"><span class="book-symbol">${icon('book')}</span><span class="book-info"><b>${esc(b.title)}</b><small>${Math.ceil(b.words/165)} min <span>·</span> ${b.unread?'Unread':'Read'} <span>·</span> ${b.position>0?`${Math.round(b.position/b.words*100)}% listened`:'Not started'}</small>${tagsOf(b).length?`<span class="book-tags">${tagsOf(b).map(tag=>`<span class="tag-chip">${esc(tag)}</span>`).join('')}</span>`:''}</span>${doc?.id===b.id?'<span class="active-dot"></span>':''}</button>`).join('') || '<div class="empty">No works match.<br>Try another title, tag, or filter.</div>';
}
function renderTags(){
 $('article-tags').hidden=!doc;
 if(!doc)return;
 $('tag-chips').innerHTML=tagsOf(doc).map(tag=>`<button type="button" class="tag-chip" data-tag="${esc(tag.toLocaleLowerCase())}" title="Filter library by ${esc(tag)}">${esc(tag)}</button>`).join('')||'<span class="no-tags">No tags yet</span>';
 $<HTMLInputElement>('tags-input').value=tagsOf(doc).join(', ');
 $<HTMLInputElement>('tags-input').disabled=false;
 $('tags-status').textContent='';
 $<HTMLButtonElement>('save-tags').disabled=false;
}

async function loadBook(id:string,preserveTagDraft=false) {
 const request=++loadId; persist(); stop();
 try {
  const result=await api<Doc>(`/api/documents/${id}`); if(request!==loadId||lifecycleStates.get(id)?.deleted)return;
  const tagDraft=preserveTagDraft&&doc?.id===id&&$<HTMLInputElement>('tags-input').value!==tagsOf(doc).join(', ')?$<HTMLInputElement>('tags-input').value:null;
  doc=result;const life=lifecycleStates.get(id);if(life&&(life.lifecycle_updated>=(doc.lifecycle_updated??0)))Object.assign(doc,life);loadTimeline();$('end-note').hidden=false;
  if('mediaSession' in navigator)navigator.mediaSession.metadata=new MediaMetadata({title:doc.title,artist:'Local Reader',album:'Your library'});
  let savedPosition=doc.position;
  try{const local=JSON.parse(localStorage.getItem('reader-position-'+doc.id)||'null');if(local&&local.updated>doc.updated)savedPosition=local.word;}catch{}
  current=Math.min(savedPosition,doc.words.length-1); highlighted=null;
  $('title').textContent=doc.title; $('playing-title').textContent=doc.title;
  $('collection').textContent='ALL WORKS'; $('doc-label').textContent='FROM YOUR LIBRARY';renderTags();renderReadState();
  if(tagDraft!==null){$<HTMLInputElement>('tags-input').value=tagDraft;$('tags-status').textContent='Library updated; your unsaved tag edit is kept.';}
  $('word-count').textContent=`${doc.words.length.toLocaleString()} words`;
  $('read-time').textContent=`About ${Math.ceil(doc.words.length/165)} minutes of listening`;
  const source=$<HTMLAnchorElement>('source');source.hidden=!doc.source;
  if(doc.source.startsWith('https://')||doc.source.startsWith('http://')) source.href=doc.source; else source.removeAttribute('href');
  $<HTMLInputElement>('progress').max=String(doc.words.length-1);
  renderDocument(doc);
  $('scroll-area').scrollTop=0; renderLibrary();updatePosition(current,true);status('Ready when you are');
  if(current>0) $('w-'+current)?.scrollIntoView({block:'center'});
  document.body.classList.remove('library-open'); localStorage.setItem('reader-document',id);
 } catch(error) {toast((error as Error).message);}
}
function renderDocument(value:Doc){
 const words=formattedWords(value.words,value.marks);
 const images=(value.images||[]).filter(image=>/^\/api\/images\/[0-9a-f]{64}\.(png|jpg|jpeg|webp|gif)$/.test(image.src)).sort((a,b)=>a.position-b.position);
 let imageIndex=0;
 const figure=(image:ArticleImage)=>`<figure class="article-image"><img src="${esc(image.src)}" alt="${esc(image.alt)}" loading="lazy" decoding="async">${image.caption?`<figcaption>${esc(image.caption)}</figcaption>`:''}</figure>`;
 let html='';
 for(const [i,p] of value.paragraphs.entries()){
  let cursor=p.start;
  const text=(end:number)=>{if(end<=cursor)return '';const tag=p.kind==='heading'?'h2':p.kind==='blockquote'?'blockquote':'p';const result=`<${tag} data-paragraph="${i}">${wordRun(words,cursor,end)}</${tag}>`;cursor=end;return result;};
  while(imageIndex<images.length&&images[imageIndex].position<=p.end){
   const image=images[imageIndex++];html+=text(Math.max(cursor,Math.min(p.end,image.position)))+figure(image);
  }
  html+=text(p.end);
 }
 while(imageIndex<images.length)html+=figure(images[imageIndex++]);
 $('text').innerHTML=html;
}
function resetImageImport(){pendingImages=[];capturedText='';$('import-images').hidden=true;$('import-images').textContent='';}
function loadTimeline(){
 const key=doc?JSON.stringify(['reader-timeline-v1',doc.id,backend,voice,speed]):'';
 if(key===timelineKey)return;
 timelineKey=key;timeline=[];timestampBase=null;
 if(key)try{const stored=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(stored))timeline=stored.slice(-2000);}catch{}
}
function rememberChunk(chunk:Chunk,duration:number){
 loadTimeline();
 timeline=timeline.filter(c=>c&&!(c.start===chunk.start&&c.end===chunk.end));
 timeline.push({start:chunk.start,end:chunk.end,duration,timings:chunk.timings,approximateTimings:backends.find(b=>b.id===backend)?.timing==='approximate'});
 timeline=timeline.slice(-2000);timestampBase=null;
 try{localStorage.setItem(timelineKey,JSON.stringify(timeline));}catch{/* Playback still works when browser storage is full. */}
}
function showTimestamp(active?:Scheduled,offset=0){
 if(!doc)return;
 loadTimeline();
 const word=active?active.chunk.start:current;
 if(timestampBase?.word!==word)timestampBase={word,point:timestampAt(word,timeline,speed)};
 const point=timestampBase.point;
 const approximate=point.estimated||(!active&&current>0&&backends.find(b=>b.id===backend)?.timing==='approximate');
 const label=(approximate?'~':'')+formatTimestamp(point.seconds+offset);
 if($('position-time').textContent!==label)$('position-time').textContent=label;
 $('position-time').title=approximate?'Estimated position: some preceding audio or word timing is not exact.':'Playback position from generated audio.';
}
function updatePosition(word:number,force=false) {
 if(!doc||(!force&&word===current))return;
 current=Math.max(0,Math.min(word,doc.words.length-1));
 highlighted?.classList.remove('spoken'); highlighted=$('w-'+current);highlighted?.classList.add('spoken');
 $<HTMLInputElement>('progress').value=String(current);
 const percent=current/Math.max(1,doc.words.length-1)*100;
 $('progress').style.setProperty('--progress',`${percent}%`);
 $('position-percent').textContent=`${Math.round(percent)}%`;
 if(!playing||force)showTimestamp();
 $('remaining').textContent=`~${Math.ceil((doc.words.length-current)/165/speed)} min left`;
 if(following&&playing&&performance.now()-lastFollow>1500&&highlighted) {
  const rect=highlighted.getBoundingClientRect(),container=$('scroll-area').getBoundingClientRect();
  if(rect.top<container.top+70||rect.bottom>container.bottom-100) {highlighted.scrollIntoView({behavior:'smooth',block:'center'});lastFollow=performance.now();}
 }
 updateReturnButton();
 if(performance.now()-lastSave>1500) {persist();lastSave=performance.now();}
}
function syncPlayButton() {
 $('play').innerHTML=icon(playing?'pause':'play');$('play').setAttribute('aria-label',playing?'Pause':'Play');
 document.body.classList.toggle('is-playing',playing);
 if('mediaSession' in navigator)navigator.mediaSession.playbackState=playing?'playing':'paused';
}
function clearQueue() {
 controller?.abort();controller=null;
 for(const item of scheduled) {try{item.source.stop();}catch{} item.source.disconnect();}
 scheduled=[];busy=false;
}
function stop() {
 session++;playing=false;clearQueue();syncPlayButton();
}
async function start(word=current) {
 if(!doc)return;
 if(!ready){toast(backends.find(b=>b.id===backend)?.error || 'Loading available voices. Try again in a moment.');return;}
 session++;const activeSession=session;clearQueue();
 ctx ??=new AudioContext({sampleRate:24000});
 // Resume synchronously from the user gesture, before requesting any audio.
 const resumed=ctx.resume();
 playing=true;nextWord=word;updatePosition(word,true);syncPlayButton();status('Preparing your next passage…');
 try{await resumed;if(activeSession===session)void pump();}catch(error){if(activeSession===session){stop();toast((error as Error).message);}}
}
async function toggle() {
 if(!doc)return;
 if(playing) {playing=false;await ctx?.suspend();syncPlayButton();status('Paused · your place is saved');persist();}
 else if(ctx&&scheduled.some(s=>s.until>ctx!.currentTime)) {await ctx.resume();playing=true;syncPlayButton();void pump();}
 else await start();
}
async function pump() {
 if(!playing||busy||!ctx||!doc)return;
 const until=scheduled.at(-1)?.until||ctx.currentTime;
 if(until-ctx.currentTime>28||nextWord>=doc.words.length)return;
 busy=true;const activeSession=session,activeDoc=doc;const abort=new AbortController();controller=abort;
 try {
  const chunk=await api<Chunk>('/api/chunk',{...json({document:activeDoc.id,start:nextWord,voice,speed,backend}),signal:abort.signal});
  const response=await fetch(chunk.audio,{signal:abort.signal});if(!response.ok)throw new Error('Could not load the generated audio.');
  const buffer=await ctx.decodeAudioData(await response.arrayBuffer());
  if(activeSession!==session)return;
  rememberChunk(chunk,buffer.duration);
  const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);
  const at=Math.max(ctx.currentTime+0.065,scheduled.at(-1)?.until||0);
  source.start(at);scheduled.push({chunk,at,until:at+buffer.duration,source});nextWord=chunk.end;
  status(playing ? `Playing locally · ${Math.round((scheduled.at(-1)!.until-ctx.currentTime))}s ready` : 'Paused · your place is saved');
 }catch(error){
  if(activeSession===session&&!abort.signal.aborted){playing=false;await ctx?.suspend();syncPlayButton();status('Playback interrupted · press play to retry');toast((error as Error).message);}
 }finally{if(activeSession===session){busy=false;controller=null;}}
}
function advancePlayback() {
 if(playing&&ctx&&doc){
  const now=ctx.currentTime;
  while(scheduled.length>1&&scheduled[0].until<now){scheduled.shift()!.source.disconnect();}
  const active=scheduled.find(item=>item.at<=now&&item.until>now);
  if(active){
   const offset=now-active.at;let word=active.chunk.start;
   for(const timing of active.chunk.timings){if(timing.start<=offset)word=timing.word;else break;}
   updatePosition(word);showTimestamp(active,offset);
   const seconds=Math.max(0,(scheduled.at(-1)?.until||now)-now);
   status(`Playing locally · ${Math.round(seconds)}s ready${busy?' · generating ahead':''}`);
  }else if(nextWord>=doc.words.length&&!busy&&scheduled.length&&now>=scheduled.at(-1)!.until){
   updatePosition(doc.words.length-1,true);showTimestamp(scheduled.at(-1),scheduled.at(-1)!.chunk.duration);playing=false;syncPlayButton();status('Finished · a good place to pause');persist();
  }else if(busy){status('Preparing your next passage…');}
  void pump();
 }
}
function tick(){advancePlayback();requestAnimationFrame(tick);}
// Audio must continue when the reader is a background tab (rAF pauses there).
setInterval(()=>{if(document.hidden)advancePlayback();},500);

$('library').addEventListener('click',e=>{const button=(e.target as HTMLElement).closest<HTMLElement>('[data-id]');if(button){if(e.altKey||e.ctrlKey){e.preventDefault();openBookMenu(button,e.clientX,e.clientY);}else{closeBookMenu();void loadBook(button.dataset.id!);}}});
$('library').addEventListener('contextmenu',event=>{const button=(event.target as HTMLElement).closest<HTMLElement>('[data-id]');if(button){event.preventDefault();openBookMenu(button,event.clientX,event.clientY);}});
$('library').addEventListener('keydown',event=>{if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){const button=(event.target as HTMLElement).closest<HTMLElement>('[data-id]');if(button){event.preventDefault();openBookMenu(button);}}});
$('search').addEventListener('input',renderLibrary);
$('tag-filter').addEventListener('change',()=>{selectedTag=$<HTMLSelectElement>('tag-filter').value;renderLibrary();});
$('tag-chips').addEventListener('click',e=>{
 const chip=(e.target as HTMLElement).closest<HTMLElement>('[data-tag]');if(!chip)return;
 selectedTag=chip.dataset.tag!;filter='all';$<HTMLInputElement>('search').value='';
 document.querySelectorAll<HTMLElement>('[data-filter]').forEach(button=>button.classList.toggle('selected',button.dataset.filter==='all'));
 renderLibrary();document.body.classList.add('library-open');
});
$('tags-form').addEventListener('submit',async e=>{
 e.preventDefault();if(!doc)return;
 const id=doc.id,input=$<HTMLInputElement>('tags-input'),button=$<HTMLButtonElement>('save-tags');
 const tags=[...new Map(input.value.split(',').map(tag=>tag.trim()).filter(Boolean).map(tag=>[tag.toLocaleLowerCase(),tag])).values()];
 if(button.disabled)return;
 button.disabled=true;input.disabled=true;$('tags-status').textContent='Saving…';
 try{
  const result=await api<{tags:string[]}>(`/api/documents/${encodeURIComponent(id)}/tags`,{...json({tags}),method:'PUT'});
  const saved=books.find(book=>book.id===id);if(saved)saved.tags=result.tags;
  if(doc?.id===id){doc.tags=result.tags;renderTags();$('tags-status').textContent='Tags saved.';}
  renderLibrary();
 }catch(error){if(doc?.id===id)$('tags-status').textContent=(error as Error).message;else toast((error as Error).message);}
 finally{if(doc?.id===id){button.disabled=false;input.disabled=false;}}
});
document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter!;document.querySelector('.filters .selected')?.classList.remove('selected');button.classList.add('selected');renderLibrary();});
$('text').addEventListener('click',e=>{if((e.target as HTMLElement).closest('a'))return;const word=(e.target as HTMLElement).closest<HTMLElement>('[data-word]');if(word)void start(Number(word.dataset.word));});
$('play').onclick=()=>void toggle();
$('progress').addEventListener('change',()=>void start(Number($<HTMLInputElement>('progress').value)));
function paragraphJump(direction:number){if(!doc)return;const index=doc.paragraphs.findIndex(p=>p.start<=current&&p.end>current);const p=doc.paragraphs[Math.max(0,Math.min(index+direction,doc.paragraphs.length-1))];void start(p.start);}
$('previous').onclick=()=>paragraphJump(-1);$('next').onclick=()=>paragraphJump(1);
$('voice').addEventListener('change',()=>{voice=$<HTMLSelectElement>('voice').value;localStorage.setItem('reader-voice-'+backend,voice);if(backend==='kokoro')localStorage.setItem('reader-voice',voice);if(playing)void start();else {stop();showTimestamp();status('Voice updated · press play');}});
function showSpeed(){
 $('pace-button').textContent=`${Number(speed.toFixed(2))}×`;
 $<HTMLInputElement>('speed-slider').value=String(speed);
 $<HTMLInputElement>('speed-custom').value=String(speed);
 document.querySelectorAll<HTMLElement>('[data-speed]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.speed)===speed));
}
function changeSpeed(value:number){
 if(!Number.isFinite(value))return;
 speed=Math.round(Math.max(.5,Math.min(4,value))*100)/100;
 localStorage.setItem('reader-speed',String(speed));showSpeed();updatePosition(current,true);
 if(playing)void start();else{stop();status('Pace updated · your place is saved');}
}
showSpeed();
document.querySelectorAll<HTMLElement>('[data-speed]').forEach(b=>b.onclick=()=>{changeSpeed(Number(b.dataset.speed));$('pace-panel').hidePopover();});
$('speed-slider').addEventListener('input',()=>{$<HTMLInputElement>('speed-custom').value=$<HTMLInputElement>('speed-slider').value;});
$('speed-slider').addEventListener('change',()=>changeSpeed(Number($<HTMLInputElement>('speed-slider').value)));
$('speed-custom').addEventListener('change',()=>changeSpeed(Number($<HTMLInputElement>('speed-custom').value)));
function updateReturnButton(){
 const rect=highlighted?.getBoundingClientRect(),area=$('scroll-area').getBoundingClientRect();
 const away=!!rect&&(rect.top<area.top+30||rect.bottom>area.bottom-30);
 $('return-current').hidden=!doc||(!away&&following);
}
function setFollowing(value:boolean){
 following=value;$('follow').setAttribute('aria-pressed',String(value));updateReturnButton();
}
function returnToReading(){
 if(!doc)return;
 setFollowing(true);lastFollow=performance.now();
 highlighted?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});
}
$('return-current').onclick=returnToReading;
$('follow').onclick=()=>{if(following)setFollowing(false);else returnToReading();};
// Browsing pauses follow until explicitly resumed; never snap back on a timer.
const pauseFollowing=()=>{if(doc)setFollowing(false);};
$('scroll-area').addEventListener('wheel',pauseFollowing,{passive:true});
$('scroll-area').addEventListener('touchmove',pauseFollowing,{passive:true});
$('scroll-area').addEventListener('scroll',updateReturnButton,{passive:true});
$('scroll-area').addEventListener('pointerdown',event=>{
 const area=$('scroll-area').getBoundingClientRect();
 if(event.clientX>=area.right-18)pauseFollowing();
});
document.addEventListener('keydown',event=>{
 if(event.defaultPrevented||deleteDialog.open||dialog.open||$<HTMLDialogElement>('sync-dialog').open||(event.target as HTMLElement).closest('input,textarea,select'))return;
 if(['PageDown','PageUp','Home','End','ArrowDown','ArrowUp'].includes(event.key))pauseFollowing();
});
new ResizeObserver(updateReturnButton).observe($('scroll-area'));
$('menu').onclick=()=>document.body.classList.toggle('library-open');
$('close-library').onclick=()=>document.body.classList.remove('library-open');
const dialog=$<HTMLDialogElement>('import-dialog');
$('import').onclick=()=>{showImportTab('link');dialog.showModal();};$('close-import').onclick=()=>dialog.close();
dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
async function imported(result:ImportResult){books=await api<Book[]>('/api/library');dialog.close();$<HTMLFormElement>('paste-form').reset();$('import-error').textContent='';await loadBook(result.id);resetImageImport();toast(result.warnings?.length?'Article added. '+result.warnings.join(' '):'Added to your local library.');if(result.warnings?.length)status('Imported with image warnings · '+result.warnings.join(' '));}
$('paste-form').addEventListener('submit',async e=>{e.preventDefault();const button=$('paste-form').querySelector<HTMLButtonElement>('.submit')!;button.disabled=true;$('import-error').textContent=pendingImages.length?'Saving article and images…':'Saving…';try{await imported(await api('/api/import/text',json({title:$<HTMLInputElement>('paste-title').value,text:$<HTMLTextAreaElement>('paste-text').value,source:$<HTMLInputElement>('paste-source').value,images:pendingImages})));}catch(error){$('import-error').textContent=(error as Error).message;}finally{button.disabled=false;}});
function showImportTab(tab:string){
 for(const name of ['link','text','browser'])$('import-'+name).hidden=name!==tab;
 document.querySelectorAll<HTMLButtonElement>('[data-import-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.importTab===tab)));
 $('import-error').textContent='';
}
document.querySelectorAll<HTMLButtonElement>('[data-import-tab]').forEach(b=>b.onclick=()=>showImportTab(b.dataset.importTab!));
$('link-form').addEventListener('submit',async e=>{
 e.preventDefault();const button=$('link-form').querySelector<HTMLButtonElement>('button')!;
 button.disabled=true;$('import-error').textContent='Fetching article…';
 try{await imported(await api('/api/import/url',json({url:$<HTMLInputElement>('import-url').value})));$<HTMLFormElement>('link-form').reset();}
 catch(error){$('import-error').textContent=(error as Error).message;}finally{button.disabled=false;}
});
function previewCapture(payload:any):boolean{
 if(!payload||typeof payload.title!=='string'||typeof payload.text!=='string'||typeof payload.source!=='string')return false;
 if(!payload.text.trim()||payload.text.length>2000000||payload.title.length>300||payload.source.length>4096)return false;
 try{const url=new URL(payload.source);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return false;}catch{return false;}
 showImportTab('text');
 $<HTMLInputElement>('paste-title').value=payload.title;
 $<HTMLTextAreaElement>('paste-text').value=payload.text;
 $<HTMLInputElement>('paste-source').value=payload.source;
 pendingImages=Array.isArray(payload.images)?payload.images.slice(0,20).filter((image:unknown):image is ArticleImage=>{if(!image||typeof image!=='object')return false;const v=image as ArticleImage;return typeof v.src==='string'&&v.src.length<=7000000&&typeof v.alt==='string'&&v.alt.length<=2000&&typeof v.caption==='string'&&v.caption.length<=4000&&Number.isInteger(v.position)&&v.position>=0&&v.position<=250000;}):[];
 capturedText=payload.text;
 $('import-images').hidden=pendingImages.length===0;
 $('import-images').textContent=`${pendingImages.length} article image${pendingImages.length===1?'':'s'} will be saved for offline reading where available.`;
 if(!dialog.open)dialog.showModal();
 $('import-error').textContent='Review the captured text, then choose Add to library.';
 return true;
}
window.addEventListener('message',event=>{
 if(event.source!==window||event.origin!==location.origin||!event.data||typeof event.data!=='object')return;
 if(event.data.type==='local-reader:ping'){window.postMessage({type:'local-reader:ready'},location.origin);return;}
 if(event.data.type!=='local-reader:import-page'||!previewCapture(event.data.payload))return;
 window.postMessage({type:'local-reader:import-received'},location.origin);
 history.replaceState(null,'',location.pathname+location.search);
});
$('paste-text').addEventListener('input',()=>{
 if(!pendingImages.length||$<HTMLTextAreaElement>('paste-text').value===capturedText)return;
 // Text edits make original offsets unreliable; preserve images at the end instead.
 const end=$<HTMLTextAreaElement>('paste-text').value.trim().split(/\s+/).length;
 pendingImages=pendingImages.map(image=>({...image,position:Math.min(end,250000)}));
 $('import-images').textContent=`${pendingImages.length} images retained; after text edits they will appear at the end.`;
});
$('upload').addEventListener('change',async()=>{const file=$<HTMLInputElement>('upload').files?.[0];if(!file)return;const body=new FormData();body.append('file',file);$('import-error').textContent='Importing…';try{await imported(await api('/api/import/file',{method:'POST',body}));}catch(error){$('import-error').textContent=(error as Error).message;}});
document.addEventListener('keydown',e=>{if(deleteDialog.open||dialog.open||$<HTMLDialogElement>('sync-dialog').open||(e.target as HTMLElement).closest('input,textarea,select,button,a'))return;if(e.code==='Space'){e.preventDefault();void toggle();}if(e.code==='ArrowRight'&&doc){e.preventDefault();void start(Math.min(doc.words.length-1,current+25));}if(e.code==='ArrowLeft'){e.preventDefault();void start(Math.max(0,current-25));}});
window.addEventListener('beforeunload',persist);
window.addEventListener('pagehide',persist);
if('mediaSession' in navigator){
 navigator.mediaSession.setActionHandler('play',()=>{if(!playing)void toggle();});
 navigator.mediaSession.setActionHandler('pause',()=>{if(playing)void toggle();});
 navigator.mediaSession.setActionHandler('previoustrack',()=>paragraphJump(-1));
 navigator.mediaSession.setActionHandler('nexttrack',()=>paragraphJump(1));
}
function updateBackendControls(){
 const selected=backends.find(b=>b.id===backend);
 if(!selected)return;
 const menu=$<HTMLSelectElement>('backend');
 const html=backends.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}${b.available?'':' · not installed'}</option>`).join('');
 if(menu.innerHTML!==html)menu.innerHTML=html;
 menu.value=backend;
 const voices=$<HTMLSelectElement>('voice');
 const voiceHTML=Object.entries(selected.voices).map(([id,label])=>`<option value="${esc(id)}">${esc(label)}</option>`).join('');
 if(voices.innerHTML!==voiceHTML)voices.innerHTML=voiceHTML;
 if(!(voice in selected.voices)){voice=Object.keys(selected.voices)[0]||'';showTimestamp();}
 voices.value=voice;
 voices.disabled=!selected.available;
 ready=selected.available;
 $('timing-note').hidden=selected.timing!=='approximate';
 $('model-status').innerHTML=`<i class="${ready?'ready':''}"></i> ${esc(selected.name)} · ${selected.status==='loading'?'loading voice…':ready?'local':'setup needed'}`;
 $('model-status').title=selected.error || selected.model;
}
$('backend').addEventListener('change',()=>{
 const resume=playing;persist();stop();
 backend=$<HTMLSelectElement>('backend').value;
 localStorage.setItem('reader-backend',backend);
 voice=localStorage.getItem('reader-voice-'+backend)||'';
 updateBackendControls();showTimestamp();
 if(!ready)toast(backends.find(b=>b.id===backend)?.error||'This engine needs setup.');
 status(ready?'Engine updated · your place is saved':'Engine needs setup · choose another to listen');
 if(resume&&ready)void start();
 void checkStatus();
});
async function checkStatus(){
 if(statusTimer)clearTimeout(statusTimer);
 const requested=backend;
 try{
  const result=await api<BackendInfo & {backends:BackendInfo[]}>('/api/status?backend='+encodeURIComponent(backend));
  if(requested!==backend)return;
  backends=result.backends;updateBackendControls();
 }catch(error){
  if(requested===backend){
   // Recover stale engine preferences without altering the document or position.
   if(!['kokoro','pocket','macos'].includes(backend)){backend='kokoro';localStorage.setItem('reader-backend',backend);}
   $('model-status').textContent='Reader reconnecting…';
  }
 }
 statusTimer=setTimeout(checkStatus,3000);
}

const syncDialog=$<HTMLDialogElement>('sync-dialog');
let pairingURL='';
$('copy-pairing').onclick=async()=>{try{await navigator.clipboard.writeText(pairingURL);$('copy-pairing').textContent='Copied';$('pairing-error').textContent='Pairing link copied. Keep it private.';}catch{$('pairing-error').textContent='Could not copy the pairing link. Please try again.';}};
$('close-sync').onclick=()=>{syncDialog.close();pairingURL='';$<HTMLButtonElement>('copy-pairing').disabled=true;$<HTMLCanvasElement>('pairing-code').getContext('2d')?.clearRect(0,0,300,300);};
async function refreshSync(){
 try{const state=await api<{enabled:boolean;state:string;lastSync:number|null;error:string|null;warning?:string|null}>('/api/sync/status');
 const label=!state.enabled?'Local only':state.state==='syncing'?'Syncing…':state.error?'Offline · will retry':state.lastSync?'Synced '+new Date(state.lastSync*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'Ready to sync';
 $('sync-label').textContent=label;$('sync-detail').textContent=state.error||(state.warning?label+' · '+state.warning:label);
 }catch{$('sync-label').textContent='Reader reconnecting…';}
}
$('sync-settings').onclick=async()=>{
 syncDialog.showModal();$('copy-pairing').textContent='Copy pairing link';pairingURL='';$<HTMLButtonElement>('copy-pairing').disabled=true;void refreshSync();$('pairing-code').hidden=true;$('pairing-error').textContent='';
 try{const pair=await api<{pairingURL:string}>('/api/sync/pairing');pairingURL=pair.pairingURL;$<HTMLButtonElement>('copy-pairing').disabled=false;await QRCode.toCanvas($<HTMLCanvasElement>('pairing-code'),pair.pairingURL,{width:280,margin:2});$('pairing-code').hidden=false;}
 catch(error){$('pairing-error').textContent=(error as Error).message;}
};
$('sync-now').onclick=async()=>{const button=$<HTMLButtonElement>('sync-now');button.disabled=true;$('sync-detail').textContent='Syncing…';try{await api('/api/sync/now',json({}));await refreshLibrary();}catch(error){$('sync-detail').textContent=(error as Error).message;}finally{button.disabled=false;void refreshSync();}};
let refreshingLibrary=false;
async function refreshLibrary(){
 if(refreshingLibrary)return;refreshingLibrary=true;
 try{
  const activeAtRequest=doc?.id;const latest=await api<Book[]>('/api/library');
  for(const book of latest){const local=books.find(value=>value.id===book.id);if(local&&(local.read_updated??0)>(book.read_updated??0)){book.unread=local.unread;book.read_updated=local.read_updated;}}
  for(const book of latest){const local=books.find(b=>b.id===book.id),cached=lifecycleStates.get(book.id);const life=cached&&(cached.lifecycle_updated>(local?.lifecycle_updated??0))?cached:local;if(life&&(life.lifecycle_updated??0)>(book.lifecycle_updated??0))Object.assign(book,{archived:life.archived,deleted:life.deleted,lifecycle_updated:life.lifecycle_updated});}
  books=latest.filter(b=>!b.deleted);
  if(doc&&doc.id===activeAtRequest&&!books.some(b=>b.id===doc!.id)&&!lifecycleRequests.has(doc.id))clearDeletedDocument(doc.id);
  renderLibrary();
  // A failed local save can be retried, but must not replace newer phone progress.
  for(const [id,pending] of pendingProgress){
   const remote=latest.find(book=>book.id===id);
   if(remote&&remote.updated>pending.updated){
    pendingProgress.delete(id);
    try{const saved=JSON.parse(localStorage.getItem('reader-position-'+id)||'null');if(saved?.updated<=pending.updated)localStorage.removeItem('reader-position-'+id);}catch{}
   }else flushProgress(id);
  }
  const remote=doc&&books.find(book=>book.id===doc!.id);
  if(doc&&remote&&!readRequests.has(doc.id)&&(remote.read_updated??0)>(doc.read_updated??0)){doc.unread=remote.unread;doc.read_updated=remote.read_updated;renderReadState();}
  if(doc&&remote&&!playing&&!dialog.open&&!$<HTMLButtonElement>('save-tags').disabled){
   const changed=(remote.updated>doc.updated&&remote.position!==current)||
    JSON.stringify(tagsOf(remote))!==JSON.stringify(tagsOf(doc))||remote.title!==doc.title||remote.source!==doc.source||
    (remote.content_updated??0)>(doc.content_updated??0)||(remote.image_count!==undefined&&remote.image_count!==(doc.images?.length??0));
   if(changed)await loadBook(doc.id,true);
  }
 }catch{}finally{refreshingLibrary=false;}
}
setInterval(()=>{void refreshSync();if(!document.hidden)void refreshLibrary();},10000);
window.addEventListener('focus',()=>{void refreshLibrary();void refreshSync();});
async function init(){try{books=await api<Book[]>('/api/library');renderLibrary();const saved=localStorage.getItem('reader-document');const first=books.find(b=>b.id===saved&&!b.deleted)||[...books].filter(b=>!b.archived&&!b.deleted).sort((a,b)=>Math.max(b.updated,b.content_updated??0)-Math.max(a.updated,a.content_updated??0))[0];if(first)await loadBook(first.id);void checkStatus();void refreshSync();requestAnimationFrame(tick);}catch(error){toast((error as Error).message);}}
void init();

// Native updates wait for durable progress and never discard an open draft.
type NativeUpdateBridge={localReaderPrepareUpdate:()=>Promise<boolean>;localReaderCancelUpdate:()=>void};
const nativeUpdateBridge=window as unknown as NativeUpdateBridge;
let preparingUpdate=false;
nativeUpdateBridge.localReaderCancelUpdate=()=>{preparingUpdate=false;document.body.inert=false;document.body.removeAttribute('aria-busy');};
nativeUpdateBridge.localReaderPrepareUpdate=async()=>{
 if(preparingUpdate)throw new Error('An update is already being prepared.');
 if(readRequests.size||lifecycleRequests.size||$<HTMLButtonElement>('save-tags').disabled)throw new Error('Wait for library changes to finish saving before updating.');
 if(deleteDialog.open||dialog.open||($<HTMLInputElement>('tags-input').value.trim()!==(doc?tagsOf(doc).join(', '):'').trim()))throw new Error('Save or close your article and tag edits before updating.');
 preparingUpdate=true;document.body.inert=true;document.body.setAttribute('aria-busy','true');
 try{
  stop();persist();
  const deadline=Date.now()+8000;
  while((pendingProgress.size||progressRequests.size)&&Date.now()<deadline){for(const id of pendingProgress.keys())flushProgress(id);await new Promise(resolve=>setTimeout(resolve,100));}
  if(pendingProgress.size||progressRequests.size)throw new Error('Your reading position could not be saved yet. Reconnect the reader and try again.');
  return true;
 }catch(error){nativeUpdateBridge.localReaderCancelUpdate();throw error;}
};
