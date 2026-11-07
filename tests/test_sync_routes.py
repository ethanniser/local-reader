import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from fastapi.testclient import TestClient
from server.app import app


class SyncRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_pairing_is_local_no_store_and_preserves_secret(self):
        with patch('server.cloud_sync.load_config', return_value={'url': 'https://test.convex.site', 'token': 'a+b&c='}):
            response = self.client.get('/api/sync/pairing')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        pair = urlsplit(response.json()['pairingURL'])
        self.assertEqual((pair.scheme, pair.netloc), ('localreader', 'pair'))
        self.assertEqual(parse_qs(pair.query)['token'], ['a+b&c='])

    def test_pairing_rejects_web_origins_and_rebinding_hosts(self):
        for headers in [{'Origin': 'https://evil.example'}, {'Host': 'evil.example:8787'}, {'Origin': 'null'}]:
            self.assertEqual(self.client.get('/api/sync/pairing', headers=headers).status_code, 403)

    def test_unconfigured_pairing_is_not_exposed(self):
        with patch('server.cloud_sync.load_config', return_value=None):
            self.assertEqual(self.client.get('/api/sync/pairing').status_code, 404)
