import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_temp=tempfile.TemporaryDirectory(prefix='lifecycle-import-')
os.environ.setdefault('LOCAL_READER_DATA',_temp.name)
from server import library

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.root=Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(library,'DB',self.root/'library.sqlite3'))
        library.initialize()
        from fastapi.testclient import TestClient
        from server.app import app
        self.client=TestClient(app)
        self.doc_id=library.add_document('Story',library.paragraphs('one two three'))

    def test_archive_delete_and_reimport_keep_distinct_identities(self):
        before=library.document(self.doc_id)
        response=self.client.put(f'/api/documents/{self.doc_id}/archive',json={'archived':True})
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.json()['archived'])
        self.assertTrue(library.list_documents()[0]['archived'])
        after=library.document(self.doc_id)
        for key in ('content_updated','metadata_updated','read_updated','updated','position','words'):
            self.assertEqual(before[key],after[key])
        self.assertEqual(self.client.put(f'/api/documents/{self.doc_id}/archive',json={'archived':False}).status_code,200)
        self.assertTrue(self.client.delete(f'/api/documents/{self.doc_id}').json()['deleted'])
        self.assertEqual(self.client.get(f'/api/documents/{self.doc_id}').status_code,404)
        self.assertEqual(library.list_documents(),[])
        self.client.put(f'/api/documents/{self.doc_id}/progress',json={'word':2})
        with library.connect() as db:
            row=db.execute('SELECT * FROM documents WHERE id=?',(self.doc_id,)).fetchone()
            self.assertEqual(row['position'],before['position'])
            self.assertEqual(row['deleted'],1)
        fresh=library.add_document('Story',library.paragraphs('one two three'))
        self.assertNotEqual(fresh,self.doc_id)
        self.assertIsNotNone(library.document(fresh))
        library.initialize()
        self.assertIsNone(library.document(self.doc_id))

    def test_strict_booleans_origin_and_missing_document(self):
        for value in ['true',1,None]:
            self.assertEqual(self.client.put(f'/api/documents/{self.doc_id}/archive',json={'archived':value}).status_code,422)
        self.assertEqual(self.client.delete('/api/documents/missing').status_code,404)
        self.assertEqual(self.client.delete(f'/api/documents/{self.doc_id}',headers={'Origin':'https://evil.example'}).status_code,403)
        self.client.delete(f'/api/documents/{self.doc_id}')
        self.assertEqual(self.client.put(f'/api/documents/{self.doc_id}/archive',json={'archived':False}).status_code,404)
        self.assertEqual(self.client.put(f'/api/documents/{self.doc_id}/read-status',json={'unread':False}).status_code,404)
