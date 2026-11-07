import asyncio
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from PIL import Image

_tmp = tempfile.TemporaryDirectory(prefix='local-reader-sync-import-')
os.environ.setdefault('LOCAL_READER_DATA', _tmp.name)
from server import library, cloud_sync as sync, images

SITE='https://example-test.convex.site'


def response(body, status=200):
    return httpx.Response(status, stream=httpx.ByteStream(json.dumps(body).encode()))


class SyncTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=self.enterContext(tempfile.TemporaryDirectory())
        self.root=Path(self.temp)
        self.enterContext(patch.object(library,'DATA',self.root))
        self.enterContext(patch.object(library,'DB',self.root/'library.sqlite3'))
        self.enterContext(patch.object(images,'IMAGE_ROOT',self.root/'images'))
        library.initialize()
        (self.root/'sync.json').write_text(json.dumps({'url':SITE,'token':'TEST-TOKEN'}))
        self.token='TEST-TOKEN'
        self.remote={}
        self.requests=[]
        self.hook=None
        self.image_data=None

    def document(self, id='remote', **updates):
        return {'id':id,'title':'Story','source':'https://example.org','words':['one','two','three'],
                'paragraphs':[{'start':0,'end':3,'kind':'paragraph'}],'images':[], 'tags':['phone'],
                'position':1,'updated':100,'metadataUpdated':100,'contentUpdated':100, **updates}

    def handler(self, request):
        self.assertEqual(request.headers['authorization'],'Bearer '+self.token)
        self.assertEqual(request.url.host,'example-test.convex.site')
        self.requests.append((request.method,request.url.path))
        if self.hook:
            self.hook(request)
        if request.url.path=='/sync':
            return response({'documents':[dict(d,words=len(d['words'])) for d in self.remote.values()], 'serverTime':100})
        if request.url.path=='/documents':
            if request.method=='GET':
                item=self.remote[request.url.params['id']]
                return response(item,404 if item.get('deleted') else 200)
            doc=json.loads(request.content)
            if self.remote.get(doc['id'],{}).get('deleted'):
                return response({'ignored':True,'deleted':True})
            self.remote[doc['id']]=doc
            return response({'ok':True})
        if request.url.path=='/lifecycle':
            item=json.loads(request.content)
            current=self.remote.get(item['id'])
            if current is None:
                if not item['deleted']:return response({},404)
                self.remote[item['id']]=self.document(item['id'],words=[],paragraphs=[],**{k:v for k,v in item.items() if k!='id'})
            elif not current.get('deleted') and item['lifecycleUpdated']>current.get('lifecycleUpdated',-1):
                current.update(item)
            return response(self.remote[item['id']])
        if request.url.path in ('/progress','/tags','/read-status'):
            data=json.loads(request.content)
            if not self.remote[data['id']].get('deleted'):self.remote[data['id']].update(data)
            return response({'ok':True})
        if request.url.path=='/images':
            if request.method=='POST':
                self.image_data=request.content
                return response({'id':'image1','url':'/images?id=image1'})
            return httpx.Response(200,stream=httpx.ByteStream(self.image_data))
        raise AssertionError(request.url)

    async def run_sync(self, handler=None):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler or self.handler)) as client:
            result=await sync.sync_once(client=client)
        self.assertEqual(result['state'],'ready',result)
        return result

    async def test_upload_local_and_no_repeated_content(self):
        id=library.add_document('Local',[{'text':'one two three','kind':'paragraph'}])
        await self.run_sync()
        self.assertEqual(self.remote[id]['words'],['one','two','three'])
        self.assertGreater(self.remote[id]['contentUpdated'],0)
        self.requests=[]
        await self.run_sync()
        self.assertEqual(self.requests,[('GET','/sync')])

    async def test_download_new_document_and_independent_fields(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        got=library.document('remote')
        self.assertEqual(got['words'],['one','two','three'])
        self.assertEqual(got['tags'],['phone'])
        library.update_tags('remote',['desktop'])
        self.remote['remote'].update(position=2,updated=200)
        await self.run_sync()
        self.assertEqual(library.document('remote')['position'],2)
        self.assertEqual(self.remote['remote']['tags'],['desktop'])

    async def test_reading_during_network_is_not_lost(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        self.remote['remote'].update(updated=200, position=0, contentUpdated=200)
        def hook(request):
            if request.url.path=='/documents' and request.method=='GET':
                with library.connect() as db:
                    db.execute('UPDATE documents SET position=2,updated=300 WHERE id=?',('remote',))
                library.update_tags('remote',['during-sync'])
        self.hook=hook
        await self.run_sync()
        self.assertEqual(library.document('remote')['position'],2)
        self.assertEqual(self.remote['remote']['position'],2)
        self.assertEqual(self.remote['remote']['tags'],['during-sync'])

    async def test_remote_metadata_only_updates_title_source_without_content(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        self.remote['remote'].update(title='Renamed on phone',source='https://example.org/new',tags=['new'],metadataUpdated=200)
        self.requests=[]
        await self.run_sync()
        got=library.document('remote')
        self.assertEqual((got['title'],got['source'],got['tags']),('Renamed on phone','https://example.org/new',['new']))
        self.assertEqual(got['words'],['one','two','three'])
        self.assertNotIn(('GET','/documents'),self.requests)

    async def test_remote_content_does_not_overwrite_newer_local_metadata(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        with library.connect() as db:
            db.execute('UPDATE documents SET title=?,source=?,metadata_updated=300,position=2,updated=300 WHERE id=?',
                       ('Desktop title','https://example.org/desktop','remote'))
        self.remote['remote'].update(words=['short'],paragraphs=[{'start':0,'end':1,'kind':'paragraph'}],contentUpdated=200)
        await self.run_sync()
        got=library.document('remote')
        self.assertEqual((got['title'],got['source']),('Desktop title','https://example.org/desktop'))
        self.assertEqual(got['words'],['short'])
        self.assertEqual(got['position'],0)
        self.assertEqual(got['updated'],300)
        self.assertEqual(self.remote['remote']['title'],'Desktop title')
        self.assertEqual(self.remote['remote']['source'],'https://example.org/desktop')
        self.assertEqual(self.remote['remote']['words'],['short'])

    async def test_local_title_update_pushes_full_upsert_but_tags_only_uses_tags(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        with library.connect() as db:
            db.execute('UPDATE documents SET title=?,metadata_updated=200 WHERE id=?',('Desktop name','remote'))
        self.requests=[]
        await self.run_sync()
        self.assertIn(('POST','/documents'),self.requests)
        self.assertNotIn(('PUT','/tags'),self.requests)
        self.assertEqual(self.remote['remote']['title'],'Desktop name')
        library.update_tags('remote',['tag-only'])
        self.requests=[]
        await self.run_sync()
        self.assertIn(('PUT','/tags'),self.requests)
        self.assertNotIn(('POST','/documents'),self.requests)

    async def test_offline_and_redirect_keep_local_library(self):
        id=library.add_document('Local',[{'text':'words here','kind':'paragraph'}])
        for handler in [lambda req:httpx.Response(302,headers={'Location':'https://evil.example/token'}),
                        lambda req:(_ for _ in ()).throw(httpx.ConnectError('TEST-TOKEN'))]:
            calls=[]
            def wrap(request):
                calls.append(request)
                return handler(request)
            async with httpx.AsyncClient(transport=httpx.MockTransport(wrap)) as client:
                status=await sync.sync_once(client=client)
            self.assertEqual(status['state'],'error')
            self.assertNotIn('TEST-TOKEN',json.dumps(status))
            self.assertEqual(len(calls),1)
            self.assertIsNotNone(library.document(id))

    async def test_image_upload_cached_and_download_localized(self):
        output=io.BytesIO();Image.new('RGB',(2,2),'red').save(output,format='PNG')
        src=images.store_image(output.getvalue())
        id=library.add_document('Illustrated',[{'text':'one two three','kind':'paragraph'}],images=[{'src':src,'position':1,'caption':'caption'}])
        await self.run_sync()
        self.assertEqual(self.remote[id]['images'][0]['src'],'/images?id=image1')
        library.add_document('Another',[{'text':'another story','kind':'paragraph'}],images=[{'src':src,'position':1}])
        self.requests=[]
        await self.run_sync()
        self.assertNotIn(('POST','/images'),self.requests)
        self.remote['new']=self.document(id='new',images=[{'src':'/images?id=image1','position':1}])
        await self.run_sync()
        self.assertEqual(library.document('new')['images'][0]['src'],src)

    async def test_reject_external_image_before_fetch(self):
        self.remote['remote']=self.document(images=[{'src':'https://evil.example/x','position':0}])
        async with httpx.AsyncClient(transport=httpx.MockTransport(self.handler)) as client:
            result=await sync.sync_once(client=client)
        self.assertEqual(result['state'],'ready')
        self.assertEqual(result['pendingImages'],1)
        self.assertIsNotNone(library.document('remote'))
        self.assertNotIn(('GET','/images'),self.requests)

    async def test_malformed_image_keeps_text_other_documents_and_retries(self):
        self.remote['bad-image']=self.document(id='bad-image', images=[{'src':'/images?id=image1','position':1}])
        self.remote['other']=self.document(id='other')
        self.image_data=b'not a raster image'
        result=await self.run_sync()
        self.assertEqual(result['pendingImages'],1)
        self.assertIsNotNone(result['warning'])
        self.assertEqual(library.document('bad-image')['words'],['one','two','three'])
        self.assertEqual(library.document('bad-image')['images'],[])
        self.assertIsNotNone(library.document('other'))
        self.assertEqual(self.remote['bad-image']['images'][0]['src'],'/images?id=image1')
        # Same content version, repaired asset: retry must happen anyway. Reading
        # and metadata edits remain independent while the image is unavailable.
        self.remote['bad-image'].update(position=2,updated=200,tags=['repaired'],metadataUpdated=200)
        output=io.BytesIO();Image.new('RGB',(2,2),'red').save(output,format='PNG')
        self.image_data=output.getvalue()
        self.requests=[]
        result=await self.run_sync()
        restored=library.document('bad-image')
        self.assertEqual(result['pendingImages'],0)
        self.assertIsNone(result['warning'])
        self.assertEqual(restored['position'],2)
        self.assertEqual(restored['tags'],['repaired'])
        self.assertEqual(len(restored['images']),1)
        self.assertTrue(restored['images'][0]['src'].startswith('/api/images/'))
        self.assertIn(('GET','/images'),self.requests)
        self.requests=[]
        await self.run_sync()
        self.assertEqual(self.requests,[('GET','/sync')])

    async def test_pending_image_retries_after_pairing_token_rotation(self):
        self.remote['remote']=self.document(images=[{'src':'/images?id=image1','position':1}])
        self.image_data=b'broken image'
        first=await self.run_sync()
        self.assertEqual(first['pendingImages'],1)
        self.token='TEST-TOKEN-ROTATED'
        (self.root/'sync.json').write_text(json.dumps({'url':SITE,'token':self.token}))
        output=io.BytesIO();Image.new('RGB',(2,2),'blue').save(output,format='PNG')
        self.image_data=output.getvalue()
        self.requests=[]
        result=await self.run_sync()
        self.assertEqual(result['pendingImages'],0)
        self.assertEqual(len(library.document('remote')['images']),1)
        self.assertIn(('GET','/images'),self.requests)
        with library.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sync_pending_images').fetchone()[0],0)
        self.requests=[]
        await self.run_sync()
        self.assertEqual(self.requests,[('GET','/sync')])

    async def test_read_state_sync_is_independent_of_progress_and_tags(self):
        self.remote['remote']=self.document(unread=False,readUpdated=100)
        await self.run_sync()
        first=library.document('remote')
        self.assertFalse(first['unread'])
        self.remote['remote'].update(unread=True,readUpdated=200)
        await self.run_sync()
        after=library.document('remote')
        self.assertTrue(after['unread'])
        for key in ('position','updated','tags','metadata_updated','content_updated'):
            self.assertEqual(first[key],after[key],key)
        library.update_read_status('remote',False)
        self.requests=[]
        await self.run_sync()
        self.assertIn(('PUT','/read-status'),self.requests)
        self.assertNotIn(('PUT','/progress'),self.requests)
        self.assertFalse(self.remote['remote']['unread'])
        self.assertEqual(library.document('remote')['position'],first['position'])

    async def test_manual_read_toggle_during_download_wins_over_stale_cloud(self):
        self.remote['remote']=self.document(unread=True,readUpdated=100)
        await self.run_sync()
        self.remote['remote'].update(contentUpdated=200,unread=True,readUpdated=200)
        def hook(request):
            if request.url.path=='/documents' and request.method=='GET':
                library.update_read_status('remote',False)
        self.hook=hook
        await self.run_sync()
        self.assertFalse(library.document('remote')['unread'])
        self.assertFalse(self.remote['remote']['unread'])
        self.assertEqual(self.remote['remote']['position'],1)

    async def test_old_cloud_missing_read_fields_does_not_reset_local_read(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        library.update_read_status('remote',False)
        await self.run_sync()
        self.assertFalse(self.remote['remote']['unread'])
        self.assertGreater(self.remote['remote']['readUpdated'],0)
        self.remote['remote'].pop('unread')
        self.remote['remote'].pop('readUpdated')
        await self.run_sync()
        self.assertFalse(library.document('remote')['unread'])

    async def test_manual_cloud_choice_beats_legacy_read_migration_baseline(self):
        library.add_document('Legacy',[{'text':'one two three','kind':'paragraph'}],doc_id='remote',unread=False)
        with library.connect() as db:
            db.execute('ALTER TABLE documents DROP COLUMN read_updated')
        library.initialize()
        self.assertEqual(library.document('remote')['read_updated'],1)
        self.remote['remote']=self.document(unread=True,readUpdated=100)
        await self.run_sync()
        restored=library.document('remote')
        self.assertTrue(restored['unread'])
        self.assertEqual(restored['read_updated'],100)
        self.assertTrue(self.remote['remote']['unread'])
        library.initialize()
        self.assertEqual(library.document('remote')['read_updated'],100)

    async def test_formatting_roundtrip_and_independent_state_updates(self):
        marks=[{'start':0,'end':2,'kind':'italic'},{'start':2,'end':3,'kind':'link','href':'https://example.org'}]
        self.remote['remote']=self.document(marks=marks)
        await self.run_sync()
        self.assertEqual(library.document('remote')['marks'],marks)
        library.update_tags('remote',['formatting'])
        library.update_read_status('remote',False)
        await self.run_sync()
        self.assertEqual(self.remote['remote']['marks'],marks)
        local=library.add_document('Local formatted',[{'text':'one two three','kind':'paragraph'}],marks=marks)
        await self.run_sync()
        self.assertEqual(self.remote[local]['marks'],marks)

    async def test_legacy_cache_refresh_restores_marks_once_without_content_bump(self):
        marks=[{'start':0,'end':2,'kind':'bold'}]
        self.remote['remote']=self.document(marks=marks)
        await self.run_sync()
        before=library.document('remote')
        # Simulate an older desktop caching the same cloud version but discarding marks.
        with library.connect() as db:
            content=json.loads(db.execute('SELECT content FROM documents WHERE id=?',('remote',)).fetchone()[0])
            content.pop('marks')
            db.execute('UPDATE documents SET content=? WHERE id=?',(json.dumps(content),'remote'))
        self.requests=[]
        await self.run_sync()
        after=library.document('remote')
        self.assertEqual(after['marks'],marks)
        for key in ('content_updated','metadata_updated','read_updated','updated','position'):
            self.assertEqual(after[key],before[key],key)
        self.assertEqual(self.requests,[('GET','/sync'),('GET','/documents')])
        self.assertEqual(self.remote['remote']['marks'],marks)
        self.requests=[]
        await self.run_sync()
        self.assertEqual(self.requests,[('GET','/sync')])

    async def test_format_two_refresh_restores_quote_once_at_equal_clock(self):
        marks=[{'start':1,'end':2,'kind':'bold'}]
        self.remote['remote']=self.document(marks=marks,paragraphs=[{'start':0,'end':3,'kind':'blockquote'}],formatVersion=2)
        def check_opt_in(request):
            if request.url.path=='/documents' and request.method=='GET':
                self.assertEqual(request.url.params.get('format'),'2')
        self.hook=check_opt_in
        await self.run_sync()
        before=library.document('remote')
        with library.connect() as db:
            content=json.loads(db.execute('SELECT content FROM documents WHERE id=?',('remote',)).fetchone()[0])
            content.pop('formatVersion')
            content['paragraphs'][0]['kind']='paragraph'
            db.execute('UPDATE documents SET content=? WHERE id=?',(json.dumps(content),'remote'))
        self.requests=[]
        await self.run_sync()
        after=library.document('remote')
        self.assertEqual(after['paragraphs'][0]['kind'],'blockquote')
        self.assertEqual(after['marks'],marks)
        self.assertEqual(after['formatVersion'],2)
        for key in ('content_updated','metadata_updated','read_updated','updated','position'):
            self.assertEqual(after[key],before[key])
        self.assertEqual(self.requests,[('GET','/sync'),('GET','/documents')])
        self.requests=[]
        await self.run_sync()
        self.assertEqual(self.requests,[('GET','/sync')])

    async def test_legacy_plain_content_refreshes_only_once(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        with library.connect() as db:
            content=json.loads(db.execute('SELECT content FROM documents WHERE id=?',('remote',)).fetchone()[0])
            content.pop('marks')
            db.execute('UPDATE documents SET content=? WHERE id=?',(json.dumps(content),'remote'))
        await self.run_sync()
        self.assertEqual(library.document('remote')['marks'],[])
        self.requests=[]
        await self.run_sync()
        self.assertEqual(self.requests,[('GET','/sync')])

    async def test_delete_before_first_upload_only_sends_tombstone(self):
        doc_id=library.add_document('Never uploaded',library.paragraphs('one two three'))
        library.update_lifecycle(doc_id,deleted=True)
        await self.run_sync()
        self.assertTrue(self.remote[doc_id]['deleted'])
        self.assertEqual(self.requests,[('GET','/sync'),('PUT','/lifecycle')])
        self.assertIsNone(library.document(doc_id))
        self.assertEqual(library.list_documents(),[])

    async def test_cloud_delete_overrides_pending_progress_and_skips_content(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        with library.connect() as db:db.execute('UPDATE documents SET position=2,updated=300 WHERE id=?',('remote',))
        self.remote['remote'].update(deleted=True,archived=False,lifecycleUpdated=400)
        self.requests=[]
        await self.run_sync()
        self.assertIsNone(library.document('remote'))
        self.assertEqual(self.requests,[('GET','/sync')])
        self.assertTrue(self.remote['remote']['deleted'])

    async def test_delete_during_content_get_does_not_block_other_articles(self):
        self.remote['first']=self.document('first')
        self.remote['second']=self.document('second')
        def deleting(request):
            if request.url.path=='/documents' and request.url.params.get('id')=='first':
                self.remote['first'].update(deleted=True,archived=False,lifecycleUpdated=200)
        self.hook=deleting
        await self.run_sync()
        self.assertIsNotNone(library.document('second'))
        self.assertIsNone(library.document('first'))
        self.hook=None
        self.requests=[]
        await self.run_sync()
        self.assertEqual(self.requests,[('GET','/sync')])
        with library.connect() as db:self.assertEqual(db.execute('SELECT deleted FROM documents WHERE id=?',('first',)).fetchone()['deleted'],1)

    async def test_pending_delete_beats_newer_unseen_archive_without_retry_loop(self):
        self.remote['remote']=self.document(lifecycleUpdated=0,archived=False,deleted=False)
        await self.run_sync()
        library.update_lifecycle('remote',deleted=True)
        with library.connect() as db:db.execute('UPDATE documents SET lifecycle_updated=100 WHERE id=?',('remote',))
        self.remote['remote'].update(archived=True,lifecycleUpdated=200)
        await self.run_sync()
        self.assertTrue(self.remote['remote']['deleted'])
        self.assertGreater(self.remote['remote']['lifecycleUpdated'],200)
        self.requests=[]
        await self.run_sync()
        self.assertEqual(self.requests,[('GET','/sync')])

    async def test_archive_sync_preserves_content_and_read_progress_clocks(self):
        self.remote['remote']=self.document()
        await self.run_sync()
        before=library.document('remote')
        library.update_lifecycle('remote',archived=True)
        self.requests=[]
        await self.run_sync()
        self.assertTrue(self.remote['remote']['archived'])
        self.assertEqual(self.requests,[('GET','/sync'),('PUT','/lifecycle')])
        after=library.document('remote')
        for key in ('words','paragraphs','position','updated','read_updated','metadata_updated','content_updated'):
            self.assertEqual(after[key],before[key])

    def test_configuration_restricts_credentials_destination(self):
        for url in ['http://example.convex.site','https://example.convex.site.evil.org','https://evil.org',
                    'https://user:pass@example.convex.site','https://example.convex.site/path','https://example.convex.site:444',
                    'https://example.convex.site?token=x']:
            with self.assertRaises(ValueError,msg=url):
                sync.validate_config({'url':url,'token':'TEST'})


if __name__=='__main__':
    unittest.main()
