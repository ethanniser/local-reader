const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
require('./cloud-core.js');const core=globalThis.ReaderCloud;
const pairing={url:'https://parallel-test.convex.site',token:'p'.repeat(48)};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(test){for(let i=0;i<200;i++){if(test())return;await tick();}throw Error('Expected worker state was not reached');}
function fixture(){
 const drafts=new Map(),posts=[],events=[],uploads=[],gates=new Map();let active=0,max=0,rejected=false,deleted=false;
 const context=vm.createContext({crypto:webcrypto,TextEncoder,Date,Set,console,structuredClone,
 ReaderDrafts:{get:async id=>structuredClone(drafts.get(id)),put:async draft=>{await tick();drafts.set(draft.id,structuredClone(draft));}},
 ReaderCloud:{...core,uploadImage:async(config,image)=>{active++;max=Math.max(max,active);uploads.push(image.src);assert(posts.some(p=>p.source===image.owner),'Text must be posted before image work');await new Promise(resolve=>gates.set(image.src,resolve));active--;return{src:'/images?id='+image.src.split('/').at(-1),position:image.position};},request:async(config,path,options)=>{posts.push(JSON.parse(options.body));return deleted?{deleted:true,ignored:true}:{};}},
 chrome:{runtime:{id:'test',onMessage:{addListener(){}},sendMessage:async msg=>{if(msg.type==='import-pairing')return rejected?{ok:false,error:'Library connection no longer available'}:{ok:true,pairing};events.push(msg);return{ok:true};}}}});
 vm.runInContext(fs.readFileSync(__dirname+'/offscreen.js','utf8'),context);
 function add(id,count){const source='https://example.org/'+id;drafts.set(id,{id,created:Date.now(),payload:{title:id,text:'Hello world.',source,images:Array.from({length:count},(_,i)=>({src:'https://images.example.org/'+id+i,owner:source,position:i}))}});}
 return{drafts,posts,events,uploads,gates,add,run:id=>vm.runInContext(`processImport(${JSON.stringify(id)},${JSON.stringify(pairing)},['https://images.example.org/*'])`,context),release:src=>gates.get(src)(),get active(){return active;},get max(){return max;},reject(){rejected=true;},delete(){deleted=true;}};
}
(async()=>{
 const f=fixture();f.add('a',5);f.add('b',2);const jobs=[f.run('a'),f.run('b')];await until(()=>f.uploads.length===3);
 assert.equal(f.posts.length,2);assert(f.posts.every(p=>p.images.length===0));assert.equal(f.max,3);
 // Release in reverse order: output and receipt checkpoints remain source order.
 const released=new Set();while(f.uploads.length<7||f.active){await until(()=>f.uploads.some(s=>!released.has(s))||f.active===0);const src=[...f.uploads].reverse().find(s=>!released.has(s));if(src){released.add(src);f.release(src);}await tick();}
 await Promise.all(jobs);assert.equal(f.max,3);
 for(const id of ['a','b']){const saves=f.posts.filter(p=>p.id===id),first=saves[0],last=saves.at(-1);assert.equal(saves.length,2);assert(last.contentUpdated>first.contentUpdated);assert.equal(last.updated,first.updated);assert.equal(last.metadataUpdated,first.metadataUpdated);assert.equal(last.position,first.position);assert.deepEqual(last.images.map(i=>i.src),Array.from({length:id==='a'?5:2},(_,i)=>'/images?id='+id+i));assert.equal(Object.keys(f.drafts.get(id).job.uploaded).length,id==='a'?5:2);}
 const count=f.uploads.length;await f.run('a');assert.equal(f.uploads.length,count,'Checkpoint receipts must prevent duplicate image uploads');
 const d=fixture();d.add('d',4);const deletion=d.run('d');await until(()=>d.uploads.length===3);d.delete();for(let i=0;i<4;i++){await until(()=>d.uploads.length>i);d.release(d.uploads[i]);}await deletion;assert.equal(d.events.at(-1).status,'error');assert.match(d.events.at(-1).message,/article was deleted/);const previous=d.uploads.length;await d.run('d');assert.equal(d.uploads.length,previous);assert.equal(d.events.at(-1).status,'error');assert(d.posts.every(p=>p.id==='d'));
 const p=fixture();p.add('p',6);const task=p.run('p');await until(()=>p.uploads.length===3);p.reject();p.release(p.uploads[0]);await until(()=>p.drafts.get('p').job.uploaded?.[0]);await tick();assert.notEqual(p.events.at(-1).status,'error','Must await in-flight images before final error');p.release(p.uploads[1]);p.release(p.uploads[2]);await task;assert.equal(p.uploads.length,3);assert.equal(p.posts.length,1);assert.equal(p.events.at(-1).status,'error');assert.equal(p.active,0);
 console.log('Immediate readable article, global three-image limit, ordered checkpoints, retry reuse, deletion and pairing cancellation pass.');
})().catch(error=>{console.error(error);process.exitCode=1;});
