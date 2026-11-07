/* Shared, dependency-free helpers. Pairing secrets only go to validated Convex hosts. */
(function(root){
 const MAX_IMAGE=5*1024*1024;
 function config(value){
  if(!value||typeof value.url!=='string'||typeof value.token!=='string')throw new Error('Paste a valid Local Reader pairing link.');
  let url;try{url=new URL(value.url);}catch{throw new Error('Pairing requires an HTTPS Convex site.');}
  if(url.protocol!=='https:'||!/^[-a-z0-9]+\.convex\.site$/.test(url.hostname)||url.username||url.password||url.port||!['','/'].includes(url.pathname)||url.search||url.hash)throw new Error('Pairing requires an HTTPS Convex site.');
  if(!/^[\x21-\x7e]{32,4096}$/.test(value.token))throw new Error('The pairing secret is invalid. Copy a fresh pairing link.');
  return{url:url.origin,token:value.token};
 }
 function pairing(raw){
  let url;try{url=new URL(raw.trim());}catch{throw new Error('Paste the pairing link copied from Local Reader’s sync settings.');}
  if(url.protocol!=='localreader:'||url.hostname!=='pair'||url.username||url.password||url.port||!['','/'].includes(url.pathname)||url.hash||url.searchParams.getAll('url').length!==1||url.searchParams.getAll('token').length!==1)throw new Error('Paste a valid Local Reader pairing link.');
  return config({url:url.searchParams.get('url'),token:url.searchParams.get('token')});
 }
 function tags(raw){
  const list=Array.isArray(raw)?raw:raw.split(',');
  const result=[...new Set(list.map(tag=>String(tag).trim().toLowerCase().replace(/\s+/g,' ')).filter(Boolean))];
  if(result.length>20||result.some(tag=>tag.length>60))throw new Error('Use at most 20 tags, each up to 60 characters.');
  return result;
 }
 function source(raw){
  if(!raw)return'';let url;try{url=new URL(raw);}catch{throw new Error('The original article link is invalid.');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||raw.length>4096)throw new Error('The original article link is invalid.');
  return raw;
 }
 function article(draft,title,text,rawTags,images=[],now=Date.now()/1000){
  title=title.trim();if(!title||title.length>300)throw new Error('Give the article a title of up to 300 characters.');
  if(typeof text!=='string'||text.length>2000000)throw new Error('Keep article text under two million characters.');
  let words=[],paragraphs=[];
  for(const part of text.split(/\n\s*\n/)){
   const values=part.trim().split(/\s+/).filter(Boolean);if(!values.length)continue;
   const start=words.length;for(const word of values)words.push(word);paragraphs.push({start,end:words.length,kind:'paragraph'});
  }
  if(!words.length||words.length>250000||words.some(word=>word.length>10000))throw new Error('An article needs 1 to 250,000 readable words.');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(draft.id))throw new Error('This draft is invalid. Capture the page again.');
  let marks=[];
  if(text===draft.payload.text&&Array.isArray(draft.payload.words)&&Array.isArray(draft.payload.paragraphs)&&draft.payload.words.join(' ')===words.join(' ')){
   let end=0;const blocks=draft.payload.paragraphs;
   if(blocks.length&&blocks.every(p=>Number.isInteger(p.start)&&Number.isInteger(p.end)&&p.start===end&&(end=p.end)>p.start&&p.end<=words.length&&['heading','paragraph','blockquote'].includes(p.kind))&&end===words.length){paragraphs=blocks.map(p=>({start:p.start,end:p.end,kind:p.kind}));}
   for(const mark of (Array.isArray(draft.payload.marks)?draft.payload.marks:[]).slice(0,50000)){
    if(!Number.isInteger(mark.start)||!Number.isInteger(mark.end)||mark.start<0||mark.end>words.length||mark.end<=mark.start||!['bold','italic','underline','link'].includes(mark.kind))continue;
    const item={start:mark.start,end:mark.end,kind:mark.kind};
    if(mark.kind==='link'){try{item.href=source(mark.href);if(!item.href)continue;}catch{continue;}}
    marks.push(item);
   }
  }
  return{id:draft.id,title,source:source(draft.payload.source),words,paragraphs,marks,
   images:images.map(image=>({...image,position:Math.max(0,Math.min(words.length,Math.floor(image.position||0)))})),
   tags:tags(rawTags),position:0,updated:now,metadataUpdated:now,contentUpdated:now};
 }
 async function request(pair,path,options={},fetcher=fetch){
  pair=config(pair);if(!['/sync','/documents','/images'].includes(path))throw new Error('Invalid cloud endpoint.');
  const response=await fetcher(pair.url+path,{...options,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(30000),headers:{...options.headers,Authorization:'Bearer '+pair.token}});
  if(!response.ok){if(response.status===401||response.status===403)throw new Error('Pairing was rejected. Reconnect the extension with a fresh pairing link.');throw new Error('The library could not save this request (HTTP '+response.status+'). Try again.');}
  return response.json();
 }
 function imageURL(raw){
  if(typeof raw!=='string')throw new Error('Invalid image source.');
  if(/^data:image\/(png|jpeg|gif|webp);base64,/i.test(raw)){if(raw.length>MAX_IMAGE*4/3+100)throw new Error('Image exceeds 5 MB.');return raw;}
  let url;try{url=new URL(raw);}catch{throw new Error('Invalid image source.');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||raw.length>4096||!/[a-z]/i.test(url.hostname)||!url.hostname.includes('.')||/\.(local|localhost|internal)$/i.test(url.hostname)||url.hostname.startsWith('['))throw new Error('Image URL is not a supported website origin.');
  return url.href;
 }
 function imageOrigin(raw){try{const url=imageURL(raw);return url.startsWith('data:')?null:new URL(url).origin+'/*';}catch{return null;}}
 function raster(bytes){
  const starts=(...list)=>list.every((v,i)=>bytes[i]===v);
  if(starts(137,80,78,71,13,10,26,10))return'image/png';
  if(starts(255,216,255))return'image/jpeg';
  if(starts(71,73,70,56)&&[55,57].includes(bytes[4])&&bytes[5]===97)return'image/gif';
  if(starts(82,73,70,70)&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return'image/webp';
  throw new Error('Image is not a supported PNG, JPEG, GIF, or WebP.');
 }
 async function imageBytes(raw,fetcher=fetch){
  const url=imageURL(raw);let bytes;
  if(url.startsWith('data:')){
   let decoded;try{decoded=atob(url.slice(url.indexOf(',')+1));}catch{throw new Error('Image data is invalid.');}
   bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
  }else{
   // Prefer a matching browser-cache entry, including stale entries, before
   // downloading. Cache partitioning may prevent reuse of the page's own entry.
   const response=await fetcher(url,{cache:'force-cache',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok||!response.body)throw new Error('Image could not be downloaded.');
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>MAX_IMAGE)throw new Error('Image exceeds 5 MB.');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
   bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  }
  if(bytes.length>MAX_IMAGE)throw new Error('Image exceeds 5 MB.');
  return{bytes,mime:raster(bytes)};
 }
 async function rasterize(input){
  // Parse image dimensions before drawing, then decode and re-encode. The cloud
  // receives a real bounded raster, never an unverified remote file signature.
  const objectURL=URL.createObjectURL(new Blob([input.bytes],{type:input.mime}));
  try{
   const image=new Image();
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Image decoding timed out.')),15000);image.onload=()=>{clearTimeout(timer);resolve();};image.onerror=()=>{clearTimeout(timer);reject(new Error('Image data could not be decoded.'));};image.src=objectURL;});
   const width=image.naturalWidth,height=image.naturalHeight;
   if(!width||!height||width*height>24000000)throw new Error('Image dimensions are too large.');
   await image.decode();
   const scale=Math.min(1,2400/Math.max(width,height),Math.sqrt(4000000/(width*height)));
   const canvas=new OffscreenCanvas(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)));
   canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
   const blob=await canvas.convertToBlob({type:'image/webp',quality:.9});
   if(blob.size>MAX_IMAGE)throw new Error('Image exceeds 5 MB.');
   return{bytes:new Uint8Array(await blob.arrayBuffer()),mime:blob.type};
  }finally{URL.revokeObjectURL(objectURL);}
 }
 async function uploadImage(pair,image,fetcher=fetch,decoder=rasterize){
  const {bytes,mime}=await decoder(await imageBytes(image.src,fetcher));
  const result=await request(pair,'/images',{method:'POST',headers:{'Content-Type':mime},body:bytes},fetcher);
  if(typeof result.url!=='string'||!/^\/images\?id=[A-Za-z0-9_-]+$/.test(result.url))throw new Error('The library returned an invalid image receipt.');
  return{src:result.url,alt:String(image.alt||'').slice(0,2000),caption:String(image.caption||'').slice(0,4000),position:image.position||0};
 }
 const api={config,pairing,tags,source,article,request,imageURL,imageOrigin,imageBytes,uploadImage,raster,rasterize};
 root.ReaderCloud=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
