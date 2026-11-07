import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_tmp = tempfile.TemporaryDirectory(prefix='local-reader-read-import-')
os.environ.setdefault('LOCAL_READER_DATA', _tmp.name)
from server import library


class ReadStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp=self.enterContext(tempfile.TemporaryDirectory())
        self.root=Path(self.temp)
        self.enterContext(patch.object(library,'DB',self.root/'library.sqlite3'))
        library.initialize()
        self.id=library.add_document('Manual reading state',[{'text':'one two three','kind':'paragraph'}])

    def test_toggle_only_changes_read_state(self):
        with library.connect() as db:
            db.execute('UPDATE documents SET position=1,updated=123 WHERE id=?',(self.id,))
        before=library.document(self.id)
        self.assertGreater(before['read_updated'],0)
        for unread in (False,True):
            result=library.update_read_status(self.id,unread)
            after=library.document(self.id)
            self.assertEqual(after['unread'],unread)
            self.assertEqual(result['read_updated'],after['read_updated'])
            self.assertGreater(after['read_updated'],before['read_updated'])
            for key in set(before)-{'unread','read_updated'}:
                self.assertEqual(after[key],before[key],key)
            self.assertEqual(library.list_documents()[0]['read_updated'],after['read_updated'])
            before=after

    def test_migration_preserves_legacy_read_and_unread_once(self):
        other=library.add_document('Other',[{'text':'other words','kind':'paragraph'}])
        with library.connect() as db:
            db.execute('ALTER TABLE documents DROP COLUMN read_updated')
            db.execute('UPDATE documents SET unread=0,position=2,updated=99 WHERE id=?',(self.id,))
        library.initialize()
        read=library.document(self.id)
        self.assertFalse(read['unread'])
        self.assertEqual(read['read_updated'],1)
        self.assertEqual(read['position'],2)
        self.assertEqual(read['updated'],99)
        self.assertEqual(library.document(other)['read_updated'],0)
        library.initialize()
        self.assertEqual(library.document(self.id)['read_updated'],read['read_updated'])

    def test_route_strict_boolean_and_preserves_progress(self):
        from fastapi.testclient import TestClient
        from server.app import app
        client=TestClient(app)
        before=library.document(self.id)
        result=client.put(f'/api/documents/{self.id}/read-status',json={'unread':False})
        self.assertEqual(result.status_code,200)
        self.assertFalse(result.json()['unread'])
        after=library.document(self.id)
        for key in ('position','updated','tags','metadata_updated','content_updated'):
            self.assertEqual(before[key],after[key])
        for value in (0,1,'false','true',None,[]):
            self.assertEqual(client.put(f'/api/documents/{self.id}/read-status',json={'unread':value}).status_code,422)
        self.assertEqual(client.put('/api/documents/missing/read-status',json={'unread':True}).status_code,404)
        self.assertEqual(client.put(f'/api/documents/{self.id}/read-status',json={'unread':True},headers={'Origin':'https://evil.example'}).status_code,403)


if __name__=='__main__':
    unittest.main()
