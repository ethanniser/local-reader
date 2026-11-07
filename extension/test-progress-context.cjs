const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const states=[],captures=[];
const draft={id:'job',payload:{title:'Previous article',source:'https://example.com/story'},job:{requestId:'click-123'}};
const context=vm.createContext({Date,captures,importScripts(){},
 ReaderDrafts:{get:async id=>id==='job'?draft:undefined},
 ReaderCloud:{config(){throw Error('Not paired');}},
 chrome:{runtime:{onMessage:{addListener(){}}},storage:{local:{get:async()=>({}),set:async value=>states.push(value.lastImport)}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}}
});
vm.runInContext(fs.readFileSync(__dirname+'/background.js','utf8'),context);
(async()=>{
 await vm.runInContext("publish({id:'job',status:'uploading',message:'Copying images'})",context);
 assert.equal(states[0].title,draft.payload.title);assert.equal(states[0].source,draft.payload.source);assert.equal(states[0].requestId,'click-123');
 await vm.runInContext("publish({id:'missing',status:'error',message:'Missing draft'})",context);
 assert.equal(states[1].requestId,undefined);assert.equal(states[1].id,'missing');
 vm.runInContext("captureDraft=async(tabId,job)=>{captures.push({tabId,job});return 'job'};enqueueImport=async()=>{}",context);
 await vm.runInContext("sendPage(4,'click-new')",context);
 assert.equal(captures[0].job.requestId,'click-new');assert.equal(captures[0].tabId,4);
 await vm.runInContext("sendPage(4,'x'.repeat(81))",context);assert.equal(captures[1].job.requestId,undefined);
 console.log('Progress retains article identity and explicit-click correlation without inventing context for missing drafts.');
})().catch(error=>{console.error(error);process.exitCode=1});
