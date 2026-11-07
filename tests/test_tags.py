import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_test_root = tempfile.TemporaryDirectory(prefix='local-reader-tags-import-')
os.environ.setdefault('LOCAL_READER_DATA', _test_root.name)
from server import library


class TagFixture(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory(prefix='local-reader-tags-'))
        self.root = Path(self.temp)
        self.enterContext(patch.object(library, 'DB', self.root / 'library.sqlite3'))



class TagLibraryTests(TagFixture):
    def create_legacy(self):
        with library.connect() as db:
            db.execute('CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT,collection TEXT,source TEXT,unread INTEGER,content TEXT,words INTEGER,position INTEGER DEFAULT 0,updated REAL DEFAULT 0)')
            content = json.dumps({'words':['one','two','three'], 'paragraphs':[{'start':0,'end':3,'kind':'paragraph'}], 'images':[{'src':'/api/images/example.png','position':1}]})
            for doc_id, group in [('archive','Reading Group'), ('subgroup','  Computation   Lectures '), ('personal','Your documents')]:
                db.execute('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?)', (doc_id,doc_id,group,'https://example.org',1,content,3,2,123.5))
            return [tuple(row) for row in db.execute('SELECT * FROM documents ORDER BY id')]

    def test_migration_preserves_every_existing_field(self):
        before = self.create_legacy()
        library.initialize()
        with library.connect() as db:
            after = [tuple(row) for row in db.execute('SELECT id,title,collection,source,unread,content,words,position,updated FROM documents ORDER BY id')]
        self.assertEqual(before, after)
        self.assertEqual(library.document('archive')['tags'], ['reading group'])
        self.assertEqual(library.document('subgroup')['tags'], ['computation lectures'])
        self.assertEqual(library.document('personal')['tags'], [])
        self.assertEqual(library.document('archive')['images'][0]['position'], 1)

    def test_reinitialize_keeps_user_edits(self):
        self.create_legacy()
        library.initialize()
        library.update_tags('archive', ['My tag'])
        library.update_tags('subgroup', [])
        library.initialize()
        library.initialize()
        self.assertEqual(library.document('archive')['tags'], ['my tag'])
        self.assertEqual(library.document('subgroup')['tags'], [])
        self.assertEqual(len(library.list_documents()), 3)

    def test_new_documents_normalize_tags_without_changing_identity(self):
        library.initialize()
        blocks = [{'text':'A few words', 'kind':'paragraph'}]
        doc_id = library.add_document('Test', blocks)
        self.assertEqual(library.document(doc_id)['tags'], [])
        library.update_tags(doc_id, [' Reading  List ', 'READING LIST', '한국어'])
        original = library.document(doc_id)
        self.assertEqual(original['tags'], ['reading list', '한국어'])
        self.assertEqual(library.add_document('Test', blocks), doc_id)
        self.assertEqual(library.document(doc_id), original)

    def test_tag_validation_and_missing_document(self):
        library.initialize()
        self.assertIsNone(library.update_tags('missing', []))
        for tags in [[''], ['  '], ['x'*61], ['ok']*21, [123], 'tag']:
            with self.assertRaises(ValueError):
                library.normalize_tags(tags)
        self.assertEqual(library.normalize_tags(['a'*60]), ['a'*60])


class TagRouteTests(TagFixture):
    def setUp(self):
        super().setUp()
        from fastapi.testclient import TestClient
        from server.app import app
        library.initialize()
        self.client = TestClient(app)
        self.doc_id = library.add_document('Tagged document', [{'text':'one two three','kind':'paragraph'}])

    def test_routes_and_progress_preservation(self):
        self.client.put(f'/api/documents/{self.doc_id}/progress', json={'word':2})
        before = library.document(self.doc_id)
        response = self.client.put(f'/api/documents/{self.doc_id}/tags', json={'tags':[' New  tag ','NEW TAG','another']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'tags':['new tag','another']})
        result = self.client.get(f'/api/documents/{self.doc_id}').json()
        for key in ['id','words','paragraphs','position','updated']:
            self.assertEqual(result[key], before[key])
        summary = next(row for row in self.client.get('/api/library').json() if row['id'] == self.doc_id)
        self.assertEqual(summary['tags'], result['tags'])
        self.assertEqual(self.client.put(f'/api/documents/{self.doc_id}/tags', json={'tags':[]}).json(), {'tags':[]})

    def test_route_validation(self):
        for tags in [['x'*61], [''], ['t']*21, [1], 'tag']:
            response = self.client.put(f'/api/documents/{self.doc_id}/tags', json={'tags':tags})
            self.assertEqual(response.status_code, 422, str(tags))
        self.assertEqual(self.client.put('/api/documents/missing/tags', json={'tags':[]}).status_code, 404)
        self.assertEqual(self.client.put(f'/api/documents/{self.doc_id}/tags', json={'tags':['evil']}, headers={'Origin':'https://untrusted.example'}).status_code, 403)



if __name__ == '__main__':
    unittest.main()
