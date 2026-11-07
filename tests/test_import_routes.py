"""Route tests run against a temporary library; never touch the personal library."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

_temp = tempfile.TemporaryDirectory(prefix='local-reader-route-tests-')
os.environ['LOCAL_READER_DATA'] = _temp.name
from server.app import app
from server.library import initialize, document


class ImportRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server import library, images
        from importlib import import_module
        app_module = import_module('server.app')
        root = Path(_temp.name)
        cls.enterClassContext(patch.object(library, 'DATA', root))
        cls.enterClassContext(patch.object(library, 'DB', root / 'library.sqlite3'))
        cls.enterClassContext(patch.object(app_module, 'DATA', root))
        cls.enterClassContext(patch.object(images, 'IMAGE_ROOT', root / 'images'))
        initialize()
        # No lifespan startup: speech model warmup is unrelated to imports.
        cls.client = TestClient(app)

    def test_text_preserves_source(self):
        response = self.client.post('/api/import/text', json={
            'title':'Captured story', 'text':'This is the captured text.', 'source':'https://example.org/story'})
        self.assertEqual(response.status_code, 200)
        saved = document(response.json()['id'])
        self.assertEqual(saved['source'], 'https://example.org/story')
        self.assertEqual(saved['words'], ['This','is','the','captured','text.'])

    def test_reject_invalid_text_and_sources(self):
        for source in ['javascript:alert(1)', 'https://user:pass@example.org', 'https://:pass@example.org', 'http:///missing-host']:
            response = self.client.post('/api/import/text', json={'title':'Title','text':'Words','source':source})
            self.assertEqual(response.status_code, 422, source)
        for field in ['title', 'text']:
            body = {'title':'Title', 'text':'Words'}
            body[field] = ' '
            self.assertEqual(self.client.post('/api/import/text', json=body).status_code, 422)

    def test_url_route_saves_article(self):
        result = {'title':'Web story', 'blocks':[{'kind':'heading','text':'Heading'},{'kind':'paragraph','text':'Article body'}], 'source':'https://example.org/final'}
        with patch('server.article_import.import_url', AsyncMock(return_value=result)):
            response = self.client.post('/api/import/url', json={'url':'https://example.org/start'})
        self.assertEqual(response.status_code, 200)
        saved = document(response.json()['id'])
        self.assertEqual(saved['source'], result['source'])
        self.assertEqual(saved['paragraphs'][0]['kind'], 'heading')

    def test_url_errors_are_readable(self):
        with patch('server.article_import.import_url', AsyncMock(side_effect=ValueError('Use Chrome to import this page.'))):
            response = self.client.post('/api/import/url', json={'url':'https://example.org'})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()['detail'], 'Use Chrome to import this page.')

    def test_images_preserve_words_and_local_asset(self):
        from PIL import Image
        import base64
        content = io.BytesIO()
        Image.new('RGB', (120, 120), 'green').save(content, format='PNG')
        response = self.client.post('/api/import/text', json={
            'title': 'Illustrated story', 'text': 'One two three four.',
            'images': [{'src': 'data:image/png;base64,' + base64.b64encode(content.getvalue()).decode(),
                        'alt': 'Green square', 'caption': 'A caption', 'position': 2}]})
        self.assertEqual(response.status_code, 200, response.text)
        saved = document(response.json()['id'])
        self.assertEqual(saved['words'], ['One','two','three','four.'])
        self.assertEqual(saved['images'][0]['position'], 2)
        image = self.client.get(saved['images'][0]['src'])
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.headers['x-content-type-options'], 'nosniff')
        self.assertEqual(image.headers['content-type'], 'image/png')

    def test_failed_image_does_not_lose_text(self):
        response = self.client.post('/api/import/text', json={
            'title': 'Still readable', 'text': 'Text must remain available.',
            'images': [{'src': 'file:///etc/passwd', 'position': 0}]})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['warnings'])
        self.assertEqual(document(response.json()['id'])['words'][0], 'Text')

    def test_external_websites_cannot_import(self):
        for path in ['/api/import/text', '/api/import/url']:
            response = self.client.post(path, json={}, headers={'Origin':'https://attacker.example'})
            self.assertEqual(response.status_code, 403)
        response = self.client.get('/api/library', headers={'Host':'attacker.example'})
        self.assertEqual(response.status_code, 403)

    def test_extension_download_contains_manifest_and_code(self):
        response = self.client.get('/api/extension/download')
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            manifest = json.loads(archive.read('local-reader-extension/manifest.json'))
            self.assertEqual(manifest['manifest_version'], 3)
            self.assertIn('local-reader-extension/background.js', archive.namelist())


if __name__ == '__main__':
    unittest.main()
