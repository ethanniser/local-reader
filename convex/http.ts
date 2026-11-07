import { httpRouter, httpActionGeneric as httpAction, anyApi } from 'convex/server';
import { article, articleId, InputError, integer, MAX_ARTICLE_BYTES, MAX_IMAGE_BYTES, object, rasterMime, readStatus, lifecycle, tags, timestamp } from './validation';
import type { GenericActionCtx, GenericDataModel } from 'convex/server';

declare const process: {env:Record<string,string|undefined>};
const functions = anyApi;
type Context = GenericActionCtx<GenericDataModel>;
const router = httpRouter();
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
// Unpacked Chrome extension IDs vary by installation. Explicit Bearer auth is
// still required; no cookie or ambient browser credential ever authorizes sync.
const extensionOrigin = (origin: string) => /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
type Handler = (ctx:Context,request:Request)=>Promise<Response>;
const originChecked = (handler:Handler) => httpAction(async(ctx,request) => {
  const origin=request.headers.get('Origin');
  if(origin && !extensionOrigin(origin)) return json({error:'Origin is not allowed.'},403);
  const response=await handler(ctx,request);
  if(origin){
    response.headers.set('Access-Control-Allow-Origin',origin);
    const vary=response.headers.get('Vary');
    response.headers.set('Vary',vary ? vary+', Origin' : 'Origin');
  }
  return response;
});
async function authorized(request: Request) {
  const secret = process.env.SYNC_TOKEN;
  if (!secret || secret.length < 32) return false;
  const token = request.headers.get('Authorization');
  if (!token?.startsWith('Bearer ') || token.length > 4096) return false;
  const encoder = new TextEncoder();
  const [actual,expected] = await Promise.all([token.slice(7),secret].map(value => crypto.subtle.digest('SHA-256',encoder.encode(value))));
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let mismatch = 0;
  for(let i=0;i<a.length;i++) mismatch |= a[i]^b[i];
  return mismatch === 0;
}
async function readBytes(request: Request, limit: number) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) throw new InputError('Request is too large.');
  if (!request.body) throw new InputError('Request body required.');
  const reader = request.body.getReader();
  const chunks:Uint8Array[] = []; let length=0;
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>limit){await reader.cancel();throw new InputError('Request is too large.');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(length); let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}
async function readJson(request:Request,limit:number) {
  if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json') throw new InputError('Send application/json.');
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(request,limit)));}
  catch(error){if(error instanceof InputError)throw error;throw new InputError('Invalid JSON.');}
}
const guarded = (handler:Handler) => originChecked(async(ctx,request) => {
  if(!await authorized(request))return json({error:'Unauthorized.'},401);
  try {return await handler(ctx,request);}
  catch(error){
    if(error instanceof InputError)return json({error:error.message},400);
    console.error('Sync request failed', error instanceof Error ? error.name : 'unknown error');
    return json({error:'Sync request failed. Please retry.'},500);
  }
});
router.route({path:'/health',method:'GET',handler:originChecked(async()=>json({ok:true,service:'local-reader-sync'}))});
router.route({path:'/sync',method:'GET',handler:guarded(async(ctx,request)=>json({documents:await ctx.runQuery(functions.articles.list,{includeDeleted:new URL(request.url).searchParams.get('format')==='2'}),serverTime:Date.now()/1000}))});
router.route({path:'/documents',method:'GET',handler:guarded(async(ctx,request)=>{
  const id=articleId(new URL(request.url).searchParams.get('id'));
  const doc=await ctx.runQuery(functions.articles.get,{id});
  if(!doc||doc.deleted)return json({error:'Document not found.'},404);
  const blob=await ctx.storage.get(doc.contentId);
  if(!blob)return json({error:'Document content not found.'},404);
  const content=JSON.parse(await blob.text());
  const modernFormat=new URL(request.url).searchParams.get('format') === '2';
  const paragraphs=modernFormat ? content.paragraphs : content.paragraphs.map((paragraph: {kind:string}) => paragraph.kind === 'blockquote' ? {...paragraph,kind:'paragraph'} : paragraph);
  return json({...content,paragraphs,formatVersion:modernFormat ? 2 : 1,marks:content.marks ?? [],id:doc.id,title:doc.title,source:doc.source,tags:doc.tags,position:doc.position,
    updated:doc.updated,metadataUpdated:doc.metadataUpdated,contentUpdated:doc.contentUpdated,
    unread:doc.unread ?? true,readUpdated:doc.readUpdated ?? 0,archived:doc.archived ?? false,deleted:false,lifecycleUpdated:doc.lifecycleUpdated ?? 0});
})});
router.route({path:'/documents',method:'POST',handler:guarded(async(ctx,request)=>{
  const data=article(await readJson(request,MAX_ARTICLE_BYTES),new URL(request.url).origin);
  for(const image of data.images){
    const storageId=new URL(image.src,request.url).searchParams.get('id')!;
    if(!await ctx.runQuery(functions.articles.getImage,{storageId}))throw new InputError('An article image has not been uploaded.');
  }
  const contentId=await ctx.storage.store(new Blob([JSON.stringify({words:data.words,paragraphs:data.paragraphs,images:data.images,marks:data.marks,formatVersion:2})],{type:'application/json'}));
  const {words,paragraphs,images,marks,...metadata}=data;
  let result;
  try {result=await ctx.runMutation(functions.articles.upsert,{...metadata,words:words.length,contentId});}
  catch(error){await ctx.storage.delete(contentId);throw error;}
  // Rejected stale content is unreferenced. Keep accepted historical blobs so an
  // in-flight reader of a previous version can complete after a concurrent update.
  if(result.discardContentId)await ctx.storage.delete(result.discardContentId);
  return json({document:result.document,...(result.ignored ? {ignored:true,deleted:true} : {})});
})});
router.route({path:'/progress',method:'PUT',handler:guarded(async(ctx,request)=>{
  const data=object(await readJson(request,4096));
  const result=await ctx.runMutation(functions.articles.progress,{id:articleId(data.id),position:integer(data.position,'position',250000),updated:timestamp(data.updated,'updated')});
  return result ? json(result) : json({error:'Document not found.'},404);
})});
router.route({path:'/tags',method:'PUT',handler:guarded(async(ctx,request)=>{
  const data=object(await readJson(request,65536));
  const result=await ctx.runMutation(functions.articles.setTags,{id:articleId(data.id),tags:tags(data.tags),metadataUpdated:timestamp(data.metadataUpdated,'metadataUpdated')});
  return result ? json(result) : json({error:'Document not found.'},404);
})});
router.route({path:'/read-status',method:'PUT',handler:guarded(async(ctx,request)=>{
  const data=object(await readJson(request,4096));
  const result=await ctx.runMutation(functions.articles.setReadStatus,{id:articleId(data.id),...readStatus(data)});
  return result ? json(result) : json({error:'Document not found.'},404);
})});
router.route({path:'/lifecycle',method:'PUT',handler:guarded(async(ctx,request)=>{
  const data=object(await readJson(request,4096));
  const result=await ctx.runMutation(functions.articles.setLifecycle,{id:articleId(data.id),...lifecycle(data)});
  return result ? json(result) : json({error:'Document not found.'},404);
})});
router.route({path:'/images',method:'POST',handler:guarded(async(ctx,request)=>{
  const bytes=await readBytes(request,MAX_IMAGE_BYTES);
  const mime=rasterMime(bytes);
  const id=await ctx.storage.store(new Blob([bytes],{type:mime}));
  try {await ctx.runMutation(functions.articles.addImage,{storageId:id,mime,bytes:bytes.byteLength});}
  catch(error){await ctx.storage.delete(id);throw error;}
  return json({id,url:'/images?id='+encodeURIComponent(id)});
})});
router.route({path:'/images',method:'GET',handler:guarded(async(ctx,request)=>{
  const storageId=new URL(request.url).searchParams.get('id');
  if(!storageId||storageId.length>256)throw new InputError('Invalid image id.');
  const info=await ctx.runQuery(functions.articles.getImage,{storageId});
  if(!info)return json({error:'Image not found.'},404);
  const blob=await ctx.storage.get(info.storageId);
  if(!blob)return json({error:'Image not found.'},404);
  return new Response(blob,{headers:{'Content-Type':info.mime,'Cache-Control':'private, max-age=86400',
    'X-Content-Type-Options':'nosniff','Content-Disposition':'inline','Vary':'Authorization'}});
})});
for(const [path,methods] of Object.entries({
  '/health':['GET'], '/sync':['GET'], '/documents':['GET','POST'],
  '/progress':['PUT'], '/tags':['PUT'], '/read-status':['PUT'], '/lifecycle':['PUT'], '/images':['GET','POST'],
})){
  router.route({path,method:'OPTIONS',handler:originChecked(async(_ctx,request)=>{
    const origin=request.headers.get('Origin');
    const method=request.headers.get('Access-Control-Request-Method');
    const headers=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(h=>h.trim()).filter(Boolean);
    if(!origin||!method||!methods.includes(method)||headers.some(h=>!['authorization','content-type'].includes(h)))return json({error:'Invalid preflight request.'},403);
    return new Response(null,{status:204,headers:{
      'Access-Control-Allow-Methods':methods.join(', '),
      'Access-Control-Allow-Headers':'Authorization, Content-Type',
      'Access-Control-Max-Age':'600',
      'Vary':'Access-Control-Request-Method, Access-Control-Request-Headers',
    }});
  })});
}
export default router;
