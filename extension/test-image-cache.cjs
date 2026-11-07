// Isolated Chrome fixture; no personal pages, pairing, or cloud uploads.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});let primary,cdn;
 try{
  const page=await browser.newPage();
  const png=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=120;const ctx=c.getContext('2d');ctx.fillStyle='#809865';ctx.fillRect(0,0,120,120);return c.toDataURL('image/png').split(',')[1];}),'base64');
  const hits={same:0,cors:0,opaque:0};
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  cdn=http.createServer((req,res)=>{const key=req.url==='/cors.png'?'cors':'opaque';hits[key]++;if(key==='cors')res.setHeader('Access-Control-Allow-Origin','*');res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public, max-age=3600'});res.end(png);});await listen(cdn);
  const other=`http://127.0.0.1:${cdn.address().port}`;
  primary=http.createServer((req,res)=>{if(req.url==='/same.png'){hits.same++;res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public, max-age=3600'});res.end(png);return;}res.writeHead(200,{'Content-Type':'text/html'});res.end(`<article><p>Article text first.</p><img src="/same.png"><img crossorigin="anonymous" src="${other}/cors.png"><img src="${other}/opaque.png"></article>`);});await listen(primary);
  const origin=`http://127.0.0.1:${primary.address().port}`;
  await page.goto(origin);await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));const initial={...hits};
  await page.addScriptTag({path:__dirname+'/extract-article.js'});
  const code=fs.readFileSync(__dirname+'/background.js','utf8'),start=code.indexOf('function capturePage() {'),end=code.indexOf('\nasync function captureDraft(',start);
  await page.addScriptTag({content:code.slice(start,end)});const captured=await page.evaluate(()=>capturePage());
  assert.equal(captured.images.length,3);assert.match(captured.images[0].src,/^data:image\/webp;base64,/);assert.match(captured.images[1].src,/^data:image\/webp;base64,/);assert.equal(captured.images[2].src,other+'/opaque.png');
  assert.deepEqual(hits,initial,'Reading loaded pixels must not request images again');
  assert.equal(await page.evaluate(async url=>(await fetch(url,{cache:'force-cache',credentials:'omit'})).ok,origin+'/same.png'),true);assert.deepEqual(hits,initial,'Matching HTTP cache entry should avoid a new request');
  require('./cloud-core.js');const cloud=globalThis.ReaderCloud;
  await cloud.imageBytes(captured.images[0].src,()=>{throw Error('Captured image must not be downloaded');});
  let calls=0;await cloud.imageBytes('https://images.example.test/photo.png',async(url,options)=>{calls++;assert.equal(options.cache,'force-cache');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');return new Response(png);});assert.equal(calls,1);
  console.log('Loaded same-origin/CORS pixels reused without requests; opaque images use URL fallback; fallback fetch prefers cache and captured bytes never refetch.');
 }finally{await browser.close();if(primary)await new Promise(r=>primary.close(r));if(cdn)await new Promise(r=>cdn.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
