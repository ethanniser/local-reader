const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=name=>fs.readFileSync(__dirname+'/'+name,'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function inspect(state,exists=false,running=false){
 const calls=[];let listener;
 const forbidden=()=>{throw Error('Inspection must not start or mutate imports');};
 const context=vm.createContext({importScripts(){},chrome:{runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,
  getContexts:async()=>{calls.push('contexts');return exists?[{}]:[];},
  sendMessage:async msg=>{calls.push(msg.type);assert.equal(msg.type,'inspect-running');return{running};},
  onMessage:{addListener:fn=>listener=fn}},storage:{local:{get:async()=>({lastImport:state}),set:forbidden}},
  scripting:{executeScript:forbidden},offscreen:{createDocument:forbidden}},ReaderDrafts:{get:forbidden,put:forbidden},fetch:forbidden});
 vm.runInContext(read('background.js'),context);
 const response=await new Promise(resolve=>listener({type:'inspect-import'},{id:'test'},resolve));
 assert.equal(response.ok,true);return{state:response.state,calls};
}
function popup(inspection,options={}){
 const nodes=new Map(),messages=[],requests=[],permissions=[],order=[];let changed;
 const get=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,disabled:false,textContent:'',dataset:{},events:{},classList:{toggle(){},remove(){},add(){}},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(id);};
 let counter=0;
 const context=vm.createContext({URL,crypto:{randomUUID:()=>`request-${++counter}`},document:{getElementById:get},chrome:{runtime:{sendMessage:async msg=>{messages.push(msg);order.push(msg.type);return msg.type==='inspect-import'?inspection:options.send?options.send(msg):{ok:true,id:'new-id'};}},
 tabs:{query:async()=>{order.push('tab-query');return[{id:4}];}},permissions:{request:arg=>{permissions.push(arg);order.push('permission');return Promise.resolve(options.granted!==false);}},storage:{local:{get:async()=>({pairing:{url:'https://test.convex.site',token:'test'}}),setAccessLevel:async()=>{}},onChanged:{addListener:fn=>changed=fn}}},ReaderCloud:{config:p=>p,request:async(p,path)=>{requests.push(path);assert.equal(path,'/sync');return{};}},fetch:()=>{throw Error('Unexpected image/network fetch');}});
 vm.runInContext(read('popup.js'),context);
 return{get,messages,requests,permissions,order,change:state=>changed({lastImport:{newValue:state}},'local')};
}
(async()=>{
 for(const status of [null,'queued','uploading']){
  const result=await inspect(status?{id:'same-id',status}:null);
  assert.equal(result.state?.status,status?'paused':undefined);assert(!result.calls.includes('process-import'));
  const ui=popup(Promise.resolve({ok:true,state:result.state}));await settle();
  assert.deepEqual(ui.messages.map(m=>m.type),['inspect-import']);assert.deepEqual(ui.requests,['/sync']);assert.equal(ui.permissions.length,0);
  assert.equal(ui.get('send').disabled,false);assert.match(ui.get('status').textContent,/Nothing is imported/);
  if(status){assert.equal(ui.get('previous-retry').textContent,'Resume import');assert.equal(ui.get('previous-retry').hidden,false);await ui.get('previous-retry').events.click();assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))),{type:'retry-import',id:'same-id'});}
  else {ui.get('send').events.click();assert.equal(ui.permissions.length,1);await settle();assert.equal(ui.messages.at(-1).type,'send-page');assert.equal(ui.messages.at(-1).tabId,4);assert.equal(ui.messages.at(-1).requestId,'request-1');assert(ui.order.indexOf('tab-query')<ui.order.indexOf('permission'));assert(ui.order.indexOf('permission')<ui.order.indexOf('send-page'));}
 }
 const active=await inspect({id:'same-id',status:'uploading',message:'Copying images…'},true,true);
 assert.deepEqual(active.calls,['contexts','inspect-running']);assert.equal(active.state.status,'uploading');
 const activeUI=popup(Promise.resolve({ok:true,state:active.state}));await settle();assert.equal(activeUI.get('send').disabled,false);assert.match(activeUI.get('status').textContent,/Nothing is imported/);assert.match(activeUI.get('previous-status').textContent,/you started is still running/);assert.equal(activeUI.messages.length,1);
 assert.equal((await inspect({id:'same-id',status:'uploading'},true,false)).state.status,'paused');
 // Delayed inspection cannot replace live history or a clicked import.
 let resolveInspect;const ui=popup(new Promise(r=>resolveInspect=r));await settle();
 ui.change({id:'old-but-newer',status:'error',title:'Earlier article',message:'Prior failure'});
 resolveInspect({ok:true,state:active.state});await settle();assert.equal(ui.get('previous-status').textContent,'Prior failure');assert.equal(ui.get('send').disabled,false);
 // Progress can arrive before capture's response; requestId associates it with this click.
 let respond;const race=popup(Promise.resolve({ok:true,state:active.state}),{send:msg=>msg.type==='send-page'?new Promise(r=>respond=r):{ok:true}});await settle();
 race.get('send').events.click();await settle();
 race.change({id:'my-id',requestId:'request-1',status:'uploading',message:'My images 1/3'});
 assert.equal(race.get('status').textContent,'My images 1/3');assert.equal(race.get('send').disabled,true);
 race.change({id:'unrelated',requestId:'other-popup',status:'saved',message:'Another article saved'});
 assert.equal(race.get('status').textContent,'My images 1/3');assert.equal(race.get('send').disabled,true);assert.equal(race.get('previous-status').textContent,'Another article saved');
 race.change({id:'my-id',requestId:'request-1',status:'saved',message:'My article saved'});
 respond({ok:true,id:'my-id'});await settle();assert.equal(race.get('status').textContent,'My article saved');assert.equal(race.get('send').disabled,false);
 // Legacy/metadata-less early completion is adopted once the reply identifies this job.
 let replyWithoutMetadata;const legacy=popup(Promise.resolve({ok:true}),{send:()=>new Promise(r=>replyWithoutMetadata=r)});await settle();
 legacy.get('send').events.click();await settle();legacy.change({id:'legacy-id',status:'saved',message:'Already saved'});
 replyWithoutMetadata({ok:true,id:'legacy-id'});await settle();assert.equal(legacy.get('status').textContent,'Already saved');assert.equal(legacy.get('send').disabled,false);assert.equal(legacy.get('previous-import').hidden,true);
 // An old response cannot reclaim a later click, even if its completion was delivered first.
 let responses=[];const successive=popup(Promise.resolve({ok:true}),{send:()=>new Promise(r=>responses.push(r))});await settle();
 successive.get('send').events.click();await settle();successive.change({id:'one',requestId:'request-1',status:'saved',message:'One saved'});
 successive.get('send').events.click();await settle();responses[0]({ok:true,id:'one'});await settle();
 successive.change({id:'one',requestId:'request-1',status:'uploading',message:'Old job'});assert.equal(successive.get('status').textContent,'Capturing this article…');assert.equal(successive.get('send').disabled,true);
 successive.change({id:'two',requestId:'request-2',status:'saved',message:'Two saved'});responses[1]({ok:true,id:'two'});await settle();assert.equal(successive.get('status').textContent,'Two saved');
 // Denying image access still saves text/cached pixels and never retries automatically.
 const denied=popup(Promise.resolve({ok:true}),{granted:false});await settle();denied.get('send').events.click();await settle();assert.equal(denied.messages.at(-1).type,'send-page');
 denied.change({id:'new-id',requestId:'request-1',status:'saved',message:'Saved',missingOrigins:['https://images.example/*']});assert.match(denied.get('status').textContent,/Image access was not granted/);assert.equal(denied.get('allow-images').hidden,false);assert(!denied.messages.some(m=>m.type==='retry-import'));
 activeUI.change(null);assert.equal(activeUI.get('send').disabled,false);assert.equal(activeUI.get('previous-import').hidden,true);
 assert(!read('popup.js').includes('resume-import'));assert(!read('background.js').includes('resume-import'));
 console.log('Popup open never imports or asks permissions; previous jobs stay separate, explicit clicks include images, and request IDs protect progress from stale/other jobs.');
})().catch(error=>{console.error(error);process.exitCode=1;});
