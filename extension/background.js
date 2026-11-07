importScripts('drafts.js','cloud-core.js');

// This function runs only after the user clicks Send, with activeTab permission.
function capturePage() {
  if (!/^https?:$/.test(location.protocol)) {
    return {error: 'Open an article on a website first. Browser settings and PDF tabs cannot be imported.'};
  }
  const source = new URL(location.href);
  if (source.username || source.password) return {error: 'This page URL contains login credentials. Copy the article text into Local Reader instead.'};
  if (source.href.length > 4096) return {error: 'This page has an unusually long URL. Copy the article text into Local Reader instead.'};
  const selection = window.getSelection()?.toString().trim();
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const candidates = [...document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]')].filter(visible);
  const score = element => {
    const text = element.innerText || '';
    const links = [...element.querySelectorAll('a')].reduce((n, link) => n + (link.innerText || '').length, 0);
    return text.length - links * 1.5;
  };
  candidates.sort((a, b) => score(b) - score(a));
  const article = candidates[0] || document.body;
  // innerText reads rendered text, excluding display:none content and script/style text.
  // We never fetch another page, remove a paywall, or inspect browser cookies.
  let structured;
  if(typeof globalThis.extractArticleContent==='function'){const selected=window.getSelection();const range=selection&&selected?.rangeCount?selected.getRangeAt(0):null;structured=globalThis.extractArticleContent(range?range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement:article,range);}
  const text = structured?.text || selection || article?.innerText?.trim() || '';
  if (!text) return {error: 'No readable text found. Try selecting the article text first.'};
  if (text.length > 2000000) return {error: 'This page is too large. Select a shorter passage and try again.'};
  const images = [];
  let imageBytes = 0;
  if (!selection) {
    const wordCount = value => (value.match(/\S+/g) || []).length;
    // Walk preceding rendered siblings instead of Range.toString(), which includes
    // hidden DOM text and can place images after words the reader never captured.
    const before = image => {
      if(typeof globalThis.extractArticleContent==='function'&&document.createRange){const range=document.createRange();range.selectNodeContents(article);range.setEndBefore(image);return Math.min(wordCount(text),globalThis.extractArticleContent(article,range).words.length);}
      const pieces = [];
      let cursor = image;
      while (cursor && cursor !== article) {
        let sibling = cursor.previousSibling;
        while (sibling) {
          if (sibling.nodeType === 3) pieces.unshift(sibling.textContent || '');
          else if (sibling.nodeType === 1 && visible(sibling)) pieces.unshift(sibling.innerText || '');
          sibling = sibling.previousSibling;
        }
        cursor = cursor.parentElement;
      }
      return Math.min(wordCount(text), wordCount(pieces.join('\n')));
    };
    for (const image of article.querySelectorAll('img')) {
      if (images.length >= 20) break;
      if (!visible(image)) continue;
      const loaded = image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      const rect = image.getBoundingClientRect?.();
      const width = loaded ? image.naturalWidth : (rect?.width || 0);
      const height = loaded ? image.naturalHeight : (rect?.height || 0);
      if (width < 80 && height < 80) continue;
      let src = image.currentSrc || image.src || image.getAttribute?.('data-src') || image.getAttribute?.('data-original');
      if (!src) continue;
      // A same-origin/CORS-readable canvas preserves images requiring the current
      // session without copying cookies. Tainted canvases fall back to a URL.
      if (loaded) try {
        const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight),
          Math.sqrt(4000000 / (image.naturalWidth * image.naturalHeight)));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const encoded = canvas.toDataURL('image/webp', .9);
          if (/^data:image\/(png|jpeg|webp);base64,/.test(encoded) && encoded.length <= 5 * 1024 * 1024 * 4 / 3) src = encoded;
        }
      } catch { /* Cross-origin image: the reader can try a public download. */ }
      const isData = /^data:image\/(png|jpeg|webp|gif);base64,/.test(src);
      if (isData) {
        if (src.length > 5 * 1024 * 1024 * 4 / 3 || imageBytes + src.length > 30 * 1024 * 1024) continue;
      } else {
        try {
          const url = new URL(src, source.href);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) continue;
          src = url.href;
        } catch { continue; }
      }
      imageBytes += src.length;
      const caption = image.closest('figure')?.querySelector('figcaption');
      const captionText = caption && visible(caption) ? (caption.innerText || '').trim().slice(0, 2000) : '';
      // innerText already includes most figure captions. Keep them once in the
      // article text rather than duplicating them under the image.
      const normalize = value => value.replace(/\s+/g, ' ').trim();
      images.push({src, alt: (image.alt || '').slice(0, 1000),
        caption: captionText && !normalize(text).includes(normalize(captionText)) ? captionText : '',
        position: before(image)});
    }
  }
  return {title: (document.title.trim() || 'Untitled article').slice(0, 300), text, source: source.href, images, ...(structured?{words:structured.words,paragraphs:structured.paragraphs,marks:structured.marks}:{})};
}

async function captureDraft(tabId,job=null) {
  if((await ReaderDrafts.pending()).length>=20)throw new Error('You have 20 unfinished imports. Open Library settings to retry or discard them before importing more.');
  if (!Number.isInteger(tabId)) throw new Error('Choose the article tab and try again.');
  let captured;
  try {
    await chrome.scripting.executeScript({target:{tabId},files:['extract-article.js']});
    [captured] = await chrome.scripting.executeScript({target: {tabId}, func: capturePage});
  } catch {
    throw new Error('Chrome cannot read this tab. Open a normal article page, then try again. You can also copy its text into Local Reader.');
  }
  if (captured?.result?.error) throw new Error(captured.result.error);
  if (!captured?.result?.text) throw new Error(captured?.error?.message || 'No article text found. Select the passage you want and try again.');
  await ReaderDrafts.prune();
  const id=crypto.randomUUID();
  await ReaderDrafts.put({id,created:Date.now(),payload:captured.result,...(job?{job}:{})});
  return id;
}

let creatingOffscreen;
async function ensureOffscreen(){
 const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
 if(contexts.length)return;
 if(!creatingOffscreen)creatingOffscreen=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'Decode and resize article images while imports finish after the popup closes.'}).finally(()=>{creatingOffscreen=null;});
 await creatingOffscreen;
}
const importContexts=new Map();
async function publish(state){
 // Correlate progress with the explicit click that created this draft. A popup
 // opened later can label this as previous work instead of a new page capture.
 let context=importContexts.get(state.id);
 if(!context){
  let draft;try{draft=await ReaderDrafts.get(state.id);}catch{}
  context=draft?{title:draft.payload?.title||'',source:draft.payload?.source||'',requestId:draft.job?.requestId||null}:{};
  if(draft){importContexts.set(state.id,context);if(importContexts.size>32)importContexts.delete(importContexts.keys().next().value);}
 }
 await chrome.storage.local.set({lastImport:{...context,...state,at:Date.now()}});
 await chrome.action.setBadgeText({text:state.status==='saved'?'✓':state.status==='error'?'!':'…'});
 await chrome.action.setBadgeBackgroundColor({color:state.status==='error'?'#9c3932':'#526d40'});
}
async function pairingScope(pairing){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pairing.url+'#'+pairing.token)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function pairingForImport(id){
 const draft=await ReaderDrafts.get(id);if(!draft)throw new Error('Import draft is missing.');
 const {pairing}=await chrome.storage.local.get('pairing');const config=ReaderCloud.config(pairing),scope=await pairingScope(config);
 if(draft.job?.scope&&draft.job.scope!==scope)throw new Error('This import belongs to a different library. Reconnect the original library or capture this page again.');
 if(!draft.job?.scope){draft.job={...draft.job,scope,status:'queued'};await ReaderDrafts.put(draft);}
 return config;
}
async function enqueueImport(id){
 const draft=await ReaderDrafts.get(id);if(!draft)throw new Error('Import draft is missing. Capture the page again.');
 const config=await pairingForImport(id);
 const origins=[...new Set((draft.payload.images||[]).map(image=>ReaderCloud.imageOrigin(image.src)).filter(Boolean))],allowedOrigins=[];
 for(const origin of origins)if(await chrome.permissions.contains({origins:[origin]}))allowedOrigins.push(origin);
 await ensureOffscreen();
 await publish({id,status:'uploading',message:'Importing this page…'});
 await chrome.runtime.sendMessage({target:'offscreen',type:'process-import',id,pairing:config,allowedOrigins});
}
async function sendPage(tabId,requestId){
 const saved=await chrome.storage.local.get('pairing');let initialScope;try{initialScope=await pairingScope(ReaderCloud.config(saved.pairing));}catch{}
 const id=await captureDraft(tabId,{...(initialScope?{scope:initialScope}:{}),...(typeof requestId==='string'&&requestId.length<=80?{requestId}:{}),status:'queued'});
 try{await enqueueImport(id);}catch(error){const draft=await ReaderDrafts.get(id);draft.job={...draft.job,status:'error'};await ReaderDrafts.put(draft);await publish({id,status:'error',message:error.message||'Connect your library and retry this import.'});}
 return id;
}
async function inspectImport(){
 const {lastImport}=await chrome.storage.local.get('lastImport');
 if(!lastImport||!['uploading','queued'].includes(lastImport.status))return lastImport||null;
 let active=false;
 try{
  const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
  if(contexts.length){const result=await chrome.runtime.sendMessage({target:'offscreen',type:'inspect-running',id:lastImport.id});active=result?.running===true;}
 }catch{ /* Missing or suspended processor means explicit resume is needed. */ }
 if(active)return{...lastImport,message:'An import you started is still running. '+(lastImport.message||'')};
 return{...lastImport,status:'paused',message:'This import is paused. Click Resume import to continue.'};
}

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id||message?.target==='offscreen')return;
 if(message.type==='import-pairing'){if(sender.url!==chrome.runtime.getURL('offscreen.html'))return;pairingForImport(message.id).then(pairing=>reply({ok:true,pairing}),error=>reply({ok:false,error:error.message}));return true;}
 if(message.type==='import-progress'){
  if(sender.url!==chrome.runtime.getURL('offscreen.html'))return;
  publish({id:message.id,status:message.status,message:message.message,missingOrigins:message.missingOrigins||[],skipped:message.skipped||0}).then(()=>reply({ok:true}));return true;
 }
 if(message.type==='send-page'){sendPage(message.tabId,message.requestId).then(id=>reply({ok:true,id}),error=>reply({ok:false,error:error.message}));return true;}
 if(message.type==='retry-import'){enqueueImport(message.id).then(()=>reply({ok:true}),async error=>{const draft=await ReaderDrafts.get(message.id);if(draft){draft.job={...draft.job,status:'error'};await ReaderDrafts.put(draft);}await publish({id:message.id,status:'error',message:error.message});reply({ok:false,error:error.message});});return true;}
 if(message.type==='inspect-import'){
  inspectImport().then(state=>reply({ok:true,state}),error=>reply({ok:false,error:error.message}));return true;
 }
});
