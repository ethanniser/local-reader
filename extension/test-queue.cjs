const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
require('./cloud-core.js');const core=globalThis.ReaderCloud;
const pairing={url:'https://queue-test.convex.site',token:'q'.repeat(48)};
const payload={title:'Test article',text:'One bold paragraph.',source:'https://example.org/article',words:['One','bold','paragraph.'],paragraphs:[{start:0,end:3,kind:'paragraph'}],marks:[{start:1,end:2,kind:'bold'}],images:[{src:'https://images.example.org/photo.png',position:2}]};
async function scenario(){
 const drafts=new Map([['job-1',{id:'job-1',created:Date.now(),payload}]]),posts=[],progress=[];let rejectPairing=false,failDocument=false,deletedDocument=false;
 const context=vm.createContext({crypto:webcrypto,TextEncoder,Date,Set,console,structuredClone,
  ReaderDrafts:{get:async id=>structuredClone(drafts.get(id)),put:async draft=>drafts.set(draft.id,structuredClone(draft))},
  ReaderCloud:{...core,uploadImage:async()=>({src:'/images?id=photo1',alt:'',caption:'',position:2}),request:async(pair,path,options)=>{assert.equal(pair.url,pairing.url);if(failDocument){failDocument=false;throw Error('Offline. Retry when connected.');}posts.push(JSON.parse(options.body));return deletedDocument==='nested'?{document:{id:'job-1',deleted:true}}:deletedDocument?{deleted:true,ignored:true,id:'job-1'}:{document:{id:'job-1'}};}},
  chrome:{runtime:{id:'extension',onMessage:{addListener(){}},sendMessage:async message=>{
   if(message.type==='import-pairing')return rejectPairing?{ok:false,error:'This import belongs to a different library.'}:{ok:true,pairing};
   progress.push(message);return{ok:true};
  }}}
 });
 vm.runInContext(fs.readFileSync(__dirname+'/offscreen.js','utf8'),context);
 // No popup exists: background job still finishes and keeps the original id.
 await vm.runInContext(`processImport('job-1',${JSON.stringify(pairing)},[])`,context);
 assert.equal(posts.length,1);assert.equal(posts[0].id,'job-1');assert.equal(posts[0].images.length,0);assert.deepEqual(posts[0].marks,[{start:1,end:2,kind:'bold'}]);
 assert.deepEqual(Array.from(progress.at(-1).missingOrigins),['https://images.example.org/*']);
 const previous={...posts[0]};
 await vm.runInContext(`processImport('job-1',${JSON.stringify(pairing)},['https://images.example.org/*'])`,context);
 assert.equal(posts[1].id,previous.id);assert.equal(posts[2].images.length,1);assert.equal(posts[1].updated,previous.updated);assert.equal(posts[1].metadataUpdated,previous.metadataUpdated);assert(posts[1].contentUpdated>=previous.contentUpdated);
 failDocument=true;
 await vm.runInContext(`processImport('job-1',${JSON.stringify(pairing)},[])`,context);assert.equal(progress.at(-1).status,'error');
 await vm.runInContext(`processImport('job-1',${JSON.stringify(pairing)},[])`,context);assert.equal(posts.at(-1).id,'job-1');
 // Deleting a previously saved partial article is sticky: an image retry must
 // report rejection, never mint a new id or claim the tombstoned id was imported.
 deletedDocument=true;const savedEvents=progress.filter(item=>item.status==='saved').length;
 await vm.runInContext(`processImport('job-1',${JSON.stringify(pairing)},[])`,context);
 assert.equal(progress.at(-1).status,'error');assert.match(progress.at(-1).message,/article was deleted.*Capture the page again/);
 assert.equal(progress.filter(item=>item.status==='saved').length,savedEvents);assert.equal(drafts.get('job-1').job.status,'error');
 assert.equal(posts.at(-1).id,'job-1');assert.equal(drafts.size,1);
 deletedDocument='nested';await vm.runInContext(`processImport('job-1',${JSON.stringify(pairing)},[])`,context);assert.equal(progress.at(-1).status,'error');assert.match(progress.at(-1).message,/article was deleted/);assert.equal(progress.filter(item=>item.status==='saved').length,savedEvents);
 const count=posts.length;rejectPairing=true;
 await vm.runInContext(`processImport('job-1',${JSON.stringify(pairing)},[])`,context);assert.equal(posts.length,count);assert.equal(progress.at(-1).status,'error');assert.match(progress.at(-1).message,/different library/);
 console.log('Offscreen imports survive popup absence; stable retry ids, image enhancement and pairing isolation pass.');
}
scenario().catch(error=>{console.error(error);process.exitCode=1});