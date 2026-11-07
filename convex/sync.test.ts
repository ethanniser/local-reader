import { beforeEach, describe, expect, test, vi } from 'vitest';
import { defineTestApp } from 'convex-test';
import schema from './schema';
import * as articles from './articles';
import http from './http';

const app = defineTestApp({schema}).defineModules({articles,http:{default:http}});
const TOKEN='a'.repeat(64);
const auth={Authorization:`Bearer ${TOKEN}`};
const data=()=>({id:'article_1',title:'A story',source:'https://example.org/story',tags:['reading'],position:0,updated:100,
  metadataUpdated:100,contentUpdated:100,words:['One','two','three'],paragraphs:[{start:0,end:3,kind:'paragraph'}],images:[]});
const request=(body:unknown,method='POST')=>({method,headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.stubEnv('SYNC_TOKEN',TOKEN);});

describe('authenticated cloud sync',()=>{
  test('health public; all data endpoints require pairing token',async()=>{
    const t=app.createTest();
    expect((await t.fetch('/health')).status).toBe(200);
    for(const [path,method] of [['/sync','GET'],['/documents?id=article_1','GET'],['/documents','POST'],['/images?id=invalid','GET'],['/images','POST'],['/tags','PUT'],['/progress','PUT'],['/read-status','PUT'],['/lifecycle','PUT']]){
      expect((await t.fetch(path,{method})).status).toBe(401);
    }
    expect((await t.fetch('/sync',{headers:{Authorization:'Bearer wrong'}})).status).toBe(401);
    vi.stubEnv('SYNC_TOKEN','');
    expect((await t.fetch('/sync',{headers:auth})).status).toBe(401);
  });
  test('Chrome extension preflight allows only declared methods and headers',async()=>{
    const t=app.createTest();const origin='chrome-extension://'+'a'.repeat(32);
    const headers={Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'};
    const response=await t.fetch('/documents',{method:'OPTIONS',headers});
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    for(const override of [
      {Origin:'https://malicious.example'}, {Origin:'null'}, {Origin:'chrome-extension://'+'z'.repeat(32)},
      {'Access-Control-Request-Method':'DELETE'}, {'Access-Control-Request-Headers':'cookie'},
    ]){
      expect((await t.fetch('/documents',{method:'OPTIONS',headers:{...headers,...override}})).status).toBe(403);
    }
  });
  test('extension requests still require token; normal website origins are rejected',async()=>{
    const t=app.createTest();const origin='chrome-extension://'+'b'.repeat(32);
    const unauthorized=await t.fetch('/sync',{headers:{Origin:origin}});
    expect(unauthorized.status).toBe(401);expect(unauthorized.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    const accepted=await t.fetch('/documents',{...request(data()),headers:{...request(data()).headers,Origin:origin}});
    expect(accepted.status).toBe(200);expect(accepted.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    const denied=await t.fetch('/sync',{headers:{...auth,Origin:'https://untrusted.example'}});
    expect(denied.status).toBe(403);expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await t.fetch('/sync',{headers:auth})).status).toBe(200);
  });
  test('round trip stores large article content outside metadata row',async()=>{
    const t=app.createTest(); const body=data();
    body.words=Array.from({length:10000},()=> 'x'.repeat(150));
    body.paragraphs=[{start:0,end:body.words.length,kind:'paragraph'}];
    const uploaded=await t.fetch('/documents',request(body));
    expect(uploaded.status).toBe(200);
    const list=await (await t.fetch('/sync',{headers:auth})).json();
    expect(list.documents).toHaveLength(1);
    expect(list.documents[0].words).toBe(10000);
    expect(list.documents[0].contentId).toBeUndefined();
    const loaded=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(loaded).toEqual({...body,marks:[],unread:true,readUpdated:0,formatVersion:1,archived:false,deleted:false,lifecycleUpdated:0});
    const row=await t.run(async ctx=> (await ctx.db.query('articles').collect())[0]);
    expect(JSON.stringify(row).length).toBeLessThan(2000);
  });
  test('stale full uploads do not roll back newer tags or progress',async()=>{
    const t=app.createTest();
    await t.fetch('/documents',request(data()));
    await t.fetch('/progress',request({id:'article_1',position:2,updated:300},'PUT'));
    await t.fetch('/tags',request({id:'article_1',tags:['New TAG','new tag'],metadataUpdated:400},'PUT'));
    const stale={...data(),title:'Stale title',tags:['stale'],position:1,updated:200,metadataUpdated:200};
    expect((await t.fetch('/documents',request(stale))).status).toBe(200);
    const loaded=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(loaded.title).toBe('A story');
    expect(loaded.tags).toEqual(['new tag']);
    expect(loaded.position).toBe(2);
    expect(loaded.updated).toBe(300);
    expect(loaded.metadataUpdated).toBe(400);
    expect((await (await t.fetch('/progress',request({id:'article_1',position:0,updated:200},'PUT'))).json()).position).toBe(2);
  });
  test('newer content clamps preserved progress and merges independent metadata',async()=>{
    const t=app.createTest();await t.fetch('/documents',request(data()));
    await t.fetch('/progress',request({id:'article_1',position:2,updated:300},'PUT'));
    const body={...data(),title:'New title',metadataUpdated:200,contentUpdated:200,words:['Short'],paragraphs:[{start:0,end:1,kind:'paragraph'}]};
    await t.fetch('/documents',request(body));
    const result=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(result.words).toEqual(['Short']);expect(result.position).toBe(0);expect(result.updated).toBe(300);expect(result.title).toBe('New title');
  });
  test('legacy documents output read defaults and accept initial read clock zero',async()=>{
    const t=app.createTest();
    const created=await (await t.fetch('/documents',request(data()))).json();
    expect(created.document.unread).toBe(true);expect(created.document.readUpdated).toBe(0);
    const list=await (await t.fetch('/sync',{headers:auth})).json();
    expect(list.documents[0].unread).toBe(true);expect(list.documents[0].readUpdated).toBe(0);
    const marked=await t.fetch('/read-status',request({id:'article_1',unread:false,readUpdated:0},'PUT'));
    expect(marked.status).toBe(200);expect(await marked.json()).toEqual({id:'article_1',unread:false,readUpdated:0});
    const tie=await t.fetch('/read-status',request({id:'article_1',unread:true,readUpdated:0},'PUT'));
    expect((await tie.json()).unread).toBe(false);
  });
  test('manual read status is independent from progress, tags and old-client uploads',async()=>{
    const t=app.createTest();await t.fetch('/documents',request(data()));
    await t.fetch('/read-status',request({id:'article_1',unread:false,readUpdated:400},'PUT'));
    const before=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(before.updated).toBe(100);expect(before.metadataUpdated).toBe(100);expect(before.contentUpdated).toBe(100);expect(before.position).toBe(0);
    await t.fetch('/progress',request({id:'article_1',position:2,updated:600},'PUT'));
    await t.fetch('/tags',request({id:'article_1',tags:['new'],metadataUpdated:600},'PUT'));
    await t.fetch('/documents',request({...data(),title:'New content',updated:700,metadataUpdated:700,contentUpdated:700}));
    const after=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(after.unread).toBe(false);expect(after.readUpdated).toBe(400);
    const stale=await t.fetch('/read-status',request({id:'article_1',unread:true,readUpdated:399},'PUT'));
    expect((await stale.json()).unread).toBe(false);
    const newest=await t.fetch('/read-status',request({id:'article_1',unread:true,readUpdated:401},'PUT'));
    expect((await newest.json()).unread).toBe(true);
    const final=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(final.updated).toBe(after.updated);expect(final.metadataUpdated).toBe(after.metadataUpdated);expect(final.contentUpdated).toBe(after.contentUpdated);expect(final.position).toBe(after.position);
  });
  test('full document upsert merges read status with its own strict clock',async()=>{
    const t=app.createTest();await t.fetch('/documents',request({...data(),unread:false,readUpdated:200}));
    await t.fetch('/documents',request({...data(),unread:true,readUpdated:199}));
    let doc=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(doc.unread).toBe(false);expect(doc.readUpdated).toBe(200);
    await t.fetch('/documents',request({...data(),unread:true,readUpdated:200}));
    doc=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();expect(doc.unread).toBe(false);
    await t.fetch('/documents',request({...data(),unread:true,readUpdated:201}));
    doc=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();expect(doc.unread).toBe(true);expect(doc.readUpdated).toBe(201);
    expect(doc.updated).toBe(100);expect(doc.metadataUpdated).toBe(100);expect(doc.contentUpdated).toBe(100);
  });
  test('read status validates field pairs, timestamps, missing docs and extension CORS',async()=>{
    const t=app.createTest();const origin='chrome-extension://'+'a'.repeat(32);
    for(const fields of [{unread:false},{readUpdated:1},{unread:'false',readUpdated:1},{unread:null,readUpdated:1},{unread:false,readUpdated:-1},{unread:false,readUpdated:Date.now()}]){
      expect((await t.fetch('/documents',request({...data(),...fields}))).status).toBe(400);
      expect((await t.fetch('/read-status',request({id:'article_1',...fields},'PUT'))).status).toBe(400);
    }
    expect((await t.fetch('/read-status',request({id:'missing',unread:false,readUpdated:1},'PUT'))).status).toBe(404);
    const preflight=await t.fetch('/read-status',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization, content-type'}});
    expect(preflight.status).toBe(204);expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    await t.fetch('/documents',request(data()));
    const updated=await t.fetch('/read-status',{...request({id:'article_1',unread:false,readUpdated:1},'PUT'),headers:{...request({}).headers,Origin:origin}});
    expect(updated.status).toBe(200);expect(updated.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect((await t.fetch('/read-status',{...request({id:'article_1',unread:true,readUpdated:2},'PUT'),headers:{...request({}).headers,Origin:'https://untrusted.example'}})).status).toBe(403);
  });
  test('word formatting round-trips in content without leaking into metadata rows',async()=>{
    const t=app.createTest();
    const marks=[{start:0,end:2,kind:'bold'},{start:1,end:3,kind:'italic'},{start:0,end:1,kind:'underline'},{start:2,end:3,kind:'link',href:'https://example.org/read?q=1#section'}];
    expect((await t.fetch('/documents',request({...data(),marks}))).status).toBe(200);
    const loaded=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(loaded.marks).toEqual(marks);
    const row=await t.run(async ctx=>(await ctx.db.query('articles').collect())[0]);
    expect(row).not.toHaveProperty('marks');
    const listing=await (await t.fetch('/sync',{headers:auth})).json();
    expect(listing.documents[0]).not.toHaveProperty('marks');
  });
  test('marks survive metadata/progress/read changes and legacy same-clock full upload',async()=>{
    const t=app.createTest();const marks=[{start:0,end:3,kind:'bold'}];
    await t.fetch('/documents',request({...data(),marks}));
    await t.fetch('/progress',request({id:'article_1',position:2,updated:300},'PUT'));
    await t.fetch('/tags',request({id:'article_1',tags:['new'],metadataUpdated:300},'PUT'));
    await t.fetch('/read-status',request({id:'article_1',unread:false,readUpdated:300},'PUT'));
    await t.fetch('/documents',request({...data(),metadataUpdated:400,title:'Updated title'}));
    const loaded=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(loaded.marks).toEqual(marks);expect(loaded.position).toBe(2);expect(loaded.unread).toBe(false);expect(loaded.title).toBe('Updated title');
    await t.fetch('/documents',request({...data(),contentUpdated:500,marks:[{start:1,end:2,kind:'italic'}]}));
    expect((await (await t.fetch('/documents?id=article_1',{headers:auth})).json()).marks).toEqual([{start:1,end:2,kind:'italic'}]);
  });
  test('legacy content blobs lacking marks receive an empty array',async()=>{
    const t=app.createTest();await t.fetch('/documents',request(data()));
    await t.run(async ctx=>{
      const row=(await ctx.db.query('articles').collect())[0];
      const oldContent={words:data().words,paragraphs:data().paragraphs,images:[]};
      const contentId=await ctx.storage.store(new Blob([JSON.stringify(oldContent)],{type:'application/json'}));
      await ctx.db.patch(row._id,{contentId});
    });
    expect((await (await t.fetch('/documents?id=article_1',{headers:auth})).json()).marks).toEqual([]);
  });
  test('marks enforce bounded integer ranges and safe links with no raw HTML',async()=>{
    const t=app.createTest();
    const invalid=[null,{},Array(50001).fill({start:0,end:1,kind:'bold'}),
      [{start:-1,end:1,kind:'bold'}],[{start:0,end:4,kind:'bold'}],[{start:1,end:1,kind:'bold'}],
      [{start:0.5,end:1,kind:'bold'}],[{start:0,end:1.5,kind:'bold'}],[{start:0,end:1,kind:'script'}],
      [{start:0,end:1,kind:'bold',href:'https://example.org'}],
      [{start:0,end:1,kind:'link'}],
      ...['javascript:alert(1)','data:text/html,evil','file:///etc/passwd','https://user:pass@example.org','https://:pass@example.org','/relative','', 'https://example.org/'+ 'a'.repeat(4096), 'https://example.org/a\nb', 'https://example.org/a\tb', 'https://example.org/a\\b', 'https://@example.org/', 'https://example.org/'+'한'.repeat(1000)]
        .map(href=>[{start:0,end:1,kind:'link',href}])];
    for(const marks of invalid)expect((await t.fetch('/documents',request({...data(),marks}))).status).toBe(400);
    const response=await t.fetch('/documents',request({...data(),marks:[{start:0,end:1,kind:'bold',html:'<script>bad()</script>'}]}));
    expect(response.status).toBe(200);
    expect((await (await t.fetch('/documents?id=article_1',{headers:auth})).json()).marks).toEqual([{start:0,end:1,kind:'bold'}]);
  });
  test('link URLs are canonicalized for consistent desktop validation',async()=>{
    const t=app.createTest();
    const response=await t.fetch('/documents',request({...data(),marks:[{start:0,end:1,kind:'link',href:'HTTPS://Example.org/한 글'}]}));
    expect(response.status).toBe(200);
    const doc=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(doc.marks[0].href).toBe('https://example.org/%ED%95%9C%20%EA%B8%80');
  });
  test('format=2 preserves quotes while legacy downloads downgrade safely',async()=>{
    const t=app.createTest();
    const body={...data(),words:['Heading','A','bold','quote.'],paragraphs:[{start:0,end:1,kind:'heading'},{start:1,end:4,kind:'blockquote'}],marks:[{start:2,end:3,kind:'bold'}]};
    expect((await t.fetch('/documents',request(body))).status).toBe(200);
    const modern=await (await t.fetch('/documents?id=article_1&format=2',{headers:auth})).json();
    expect(modern.paragraphs).toEqual(body.paragraphs);expect(modern.marks).toEqual(body.marks);expect(modern.formatVersion).toBe(2);
    for(const suffix of ['', '&format=1']){
      const legacy=await (await t.fetch('/documents?id=article_1'+suffix,{headers:auth})).json();
      expect(legacy.paragraphs).toEqual([{start:0,end:1,kind:'heading'},{start:1,end:4,kind:'paragraph'}]);
      expect(legacy.marks).toEqual(body.marks);expect(legacy.formatVersion).toBe(1);
      // A legacy client reuploading the downgraded same-version content cannot erase quotes.
      expect((await t.fetch('/documents',request(legacy))).status).toBe(200);
    }
    expect((await (await t.fetch('/documents?id=article_1&format=2',{headers:auth})).json()).paragraphs).toEqual(body.paragraphs);
  });
  test('archive clock is independent and legacy uploads preserve lifecycle',async()=>{
    const t=app.createTest();await t.fetch('/documents',request(data()));
    const archived=await t.fetch('/lifecycle',request({id:'article_1',archived:true,deleted:false,lifecycleUpdated:200},'PUT'));
    expect(archived.status).toBe(200);
    await t.fetch('/documents',request({...data(),updated:300,metadataUpdated:300}));
    let doc=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(doc.archived).toBe(true);expect(doc.lifecycleUpdated).toBe(200);expect(doc.updated).toBe(300);
    await t.fetch('/lifecycle',request({id:'article_1',archived:false,deleted:false,lifecycleUpdated:199},'PUT'));
    doc=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();expect(doc.archived).toBe(true);
    await t.fetch('/lifecycle',request({id:'article_1',archived:false,deleted:false,lifecycleUpdated:201},'PUT'));
    doc=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();expect(doc.archived).toBe(false);expect(doc.contentUpdated).toBe(100);
  });
  test('delete before first upload creates sticky orphan tombstone',async()=>{
    const t=app.createTest();
    expect((await t.fetch('/lifecycle',request({id:'article_1',archived:false,deleted:true,lifecycleUpdated:100},'PUT'))).status).toBe(200);
    expect((await (await t.fetch('/sync',{headers:auth})).json()).documents).toEqual([]);
    let modern=await (await t.fetch('/sync?format=2',{headers:auth})).json();
    expect(modern.documents[0].deleted).toBe(true);expect(modern.documents[0].words).toBe(0);
    const stale=await (await t.fetch('/documents',request({...data(),updated:500,contentUpdated:500,archived:false,deleted:false,lifecycleUpdated:500}))).json();
    expect(stale.ignored).toBe(true);expect(stale.deleted).toBe(true);expect(stale.document.deleted).toBe(true);
    expect((await t.fetch('/documents?id=article_1&format=2',{headers:auth})).status).toBe(404);
    const restore=await (await t.fetch('/lifecycle',request({id:'article_1',archived:false,deleted:false,lifecycleUpdated:600},'PUT'))).json();
    expect(restore.deleted).toBe(true);
    modern=await (await t.fetch('/sync?format=2',{headers:auth})).json();expect(modern.documents).toHaveLength(1);
  });
  test('tombstone ignores pending field writes and hides content from old clients',async()=>{
    const t=app.createTest();await t.fetch('/documents',request(data()));
    await t.fetch('/lifecycle',request({id:'article_1',archived:true,deleted:true,lifecycleUpdated:200},'PUT'));
    for(const [path,body] of [
      ['/progress',{id:'article_1',position:2,updated:500}],
      ['/tags',{id:'article_1',tags:['late'],metadataUpdated:500}],
      ['/read-status',{id:'article_1',unread:false,readUpdated:500}],
    ] as const){
      const response=await t.fetch(path,request(body,'PUT'));expect(response.status).toBe(200);expect((await response.json()).ignored).toBe(true);
    }
    expect((await t.fetch('/documents?id=article_1',{headers:auth})).status).toBe(404);
    expect((await (await t.fetch('/sync',{headers:auth})).json()).documents).toHaveLength(0);
    const doc=(await (await t.fetch('/sync?format=2',{headers:auth})).json()).documents[0];
    expect(doc.deleted).toBe(true);expect(doc.updated).toBe(100);expect(doc.metadataUpdated).toBe(100);expect(doc.readUpdated).toBe(0);
    expect((await (await t.fetch('/documents',request(data()))).json()).ignored).toBe(true);
  });
  test('lifecycle validates triples and preflight, missing archive returns404',async()=>{
    const t=app.createTest();
    for(const fields of [{archived:true},{deleted:false},{lifecycleUpdated:1},{archived:'true',deleted:false,lifecycleUpdated:1}]){
      expect((await t.fetch('/documents',request({...data(),...fields}))).status).toBe(400);
      expect((await t.fetch('/lifecycle',request({id:'article_1',...fields},'PUT'))).status).toBe(400);
    }
    expect((await t.fetch('/lifecycle',request({id:'missing',archived:true,deleted:false,lifecycleUpdated:100},'PUT'))).status).toBe(404);
    expect((await t.fetch('/lifecycle',{method:'OPTIONS',headers:{Origin:'chrome-extension://'+'a'.repeat(32),'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization, content-type'}})).status).toBe(204);
  });
  test('invalid metadata and oversized requests are rejected',async()=>{
    const t=app.createTest();
    for(const body of [{...data(),words:[]},{...data(),tags:['']},{...data(),tags:Array(21).fill('tag')},{...data(),position:99},{...data(),updated:Date.now()}, {...data(),source:'javascript:alert(1)'},{...data(),paragraphs:[]},{...data(),paragraphs:[{start:1,end:3,kind:'paragraph'}]}]){
      expect((await t.fetch('/documents',request(body))).status).toBe(400);
    }
    expect((await t.fetch('/progress',{...request({id:'x',position:1,updated:1},'PUT'),headers:{...auth,'Content-Type':'application/json','Content-Length':'99999'}})).status).toBe(400);
    expect((await t.fetch('/progress',request({id:'missing',position:0,updated:1},'PUT'))).status).toBe(404);
  });
  test('raster upload is authenticated and never returns public storage URL',async()=>{
    const t=app.createTest();
    const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
    const response=await t.fetch('/images',{method:'POST',headers:auth,body:png});
    expect(response.status).toBe(200);
    const image=await response.json();expect(image.url).toBe('/images?id='+image.id);
    expect((await t.fetch(image.url)).status).toBe(401);
    await t.query(app.internal.articles.getImage,{storageId:image.id});
    const served=await t.fetch(image.url,{headers:auth});expect(served.status).toBe(200);expect(served.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    expect((await t.fetch('/images',{method:'POST',headers:auth,body:'<svg></svg>'})).status).toBe(400);
    expect((await t.fetch('/images?id=invalid',{headers:auth})).status).toBe(404);
  });
  test('article images must reference this library and registered raster uploads',async()=>{
    const t=app.createTest();
    const image={src:'/images?id=not-real',alt:'Picture',caption:'',position:1};
    expect((await t.fetch('/documents',request({...data(),images:[image]}))).status).toBe(400);
    expect((await t.fetch('/documents',request({...data(),images:[{...image,src:'https://evil.example/images?id=other'}]}))).status).toBe(400);
    const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
    const uploaded=await (await t.fetch('/images',{method:'POST',headers:auth,body:png})).json();
    expect((await t.fetch('/documents',request({...data(),images:[{...image,src:uploaded.url}]}))).status).toBe(200);
    const result=await (await t.fetch('/documents?id=article_1',{headers:auth})).json();
    expect(result.images[0].src).toBe(uploaded.url);
    for(const suffix of ['&extra=value','&id=other']){
      expect((await t.fetch('/documents',request({...data(),images:[{...image,src:uploaded.url+suffix}]}))).status).toBe(400);
    }
    const canonical=await t.fetch('/documents',request({...data(),id:'absolute_image',images:[{...image,src:'https://some.convex.site'+uploaded.url+'#ignored-fragment'}]}));
    expect(canonical.status).toBe(200);
    const absolute=await (await t.fetch('/documents?id=absolute_image',{headers:auth})).json();
    expect(absolute.images[0].src).toBe(uploaded.url);
  });
  test('article JSON storage cannot be fetched as an image',async()=>{
    const t=app.createTest();await t.fetch('/documents',request(data()));
    const row=await t.run(async ctx=>(await ctx.db.query('articles').collect())[0]);
    expect((await t.fetch('/images?id='+row.contentId,{headers:auth})).status).toBe(404);
  });
});
