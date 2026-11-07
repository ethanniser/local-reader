import asyncio
import socket
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from server import article_import as article

ARTICLE = '<html><title>A story</title><nav>Navigation</nav><article><h1>A story</h1><p>' + 'Useful article words. ' * 20 + '</p><script>evil()</script></article><footer>Footer</footer></html>'


class ExtractionTests(unittest.TestCase):
    def test_article_and_source(self):
        result = article.extract_html(ARTICLE, 'https://example.org/story')
        self.assertEqual(result['title'], 'A story')
        self.assertEqual(result['source'], 'https://example.org/story')
        text = ' '.join(b['text'] for b in result['blocks'])
        self.assertNotIn('Navigation', text)
        self.assertNotIn('Footer', text)
        self.assertNotIn('evil', text)

    def test_short_or_empty_page(self):
        for html in ['', '<p>Please sign in</p>']:
            with self.assertRaisesRegex(ValueError, 'Chrome'):
                article.extract_html(html)

    def test_url_validation(self):
        for url in ['file:///etc/passwd', 'ftp://example.org/a', 'https://u:p@example.org/a', 'http://example.org:22/a']:
            with self.assertRaises(ValueError):
                article.normalize_url(url)
        self.assertEqual(str(article.normalize_url(' https://example.org/a#fragment ')), 'https://example.org/a')


class FetchTests(unittest.IsolatedAsyncioTestCase):
    async def test_reject_nonpublic_dns(self):
        for address in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '224.0.0.1', 'ff02::1', '2002:7f00:1::']:
            records = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 80))]
            with patch.object(asyncio.get_running_loop(), 'getaddrinfo', AsyncMock(return_value=records)):
                with self.assertRaisesRegex(ValueError, 'private'):
                    await article.public_address(httpx.URL('http://example.org'))

    async def fetch(self, handler, value='https://example.org/story'):
        real_client = httpx.AsyncClient
        with patch.object(article, 'public_address', AsyncMock(return_value='93.184.216.34')), patch.object(
            article.httpx, 'AsyncClient', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
        ):
            return await article.import_url(value)

    async def test_pinned_ip_host_and_sni(self):
        def handler(request):
            self.assertEqual(request.url.host, '93.184.216.34')
            self.assertEqual(request.headers['host'], 'example.org')
            self.assertEqual(request.extensions['sni_hostname'], 'example.org')
            return httpx.Response(200, headers={'content-type': 'text/html'}, text=ARTICLE)
        result = await self.fetch(handler)
        self.assertEqual(result['source'], 'https://example.org/story')

    async def test_redirect_revalidated(self):
        real_client = httpx.AsyncClient
        resolve = AsyncMock(side_effect=['93.184.216.34', ValueError('private address blocked')])
        with patch.object(article, 'public_address', resolve), patch.object(article.httpx, 'AsyncClient', side_effect=lambda **kw: real_client(
            transport=httpx.MockTransport(lambda request: httpx.Response(302, headers={'location':'http://127.0.0.1/secret'})), **kw)):
            with self.assertRaisesRegex(ValueError, 'private'):
                await article.import_url('https://example.org')
        self.assertEqual(resolve.await_count, 2)

    async def test_size_type_and_http_errors(self):
        cases = [
            httpx.Response(200, headers={'content-type':'text/html'}, content=b'x'*(article.MAX_BYTES+1)),
            httpx.Response(200, headers={'content-type':'application/pdf'}, content=b'pdf'),
            httpx.Response(403, headers={'content-type':'text/html'}, text='denied'),
        ]
        for response in cases:
            with self.assertRaises(ValueError):
                await self.fetch(lambda request: response)

    async def test_redirect_limit(self):
        with self.assertRaisesRegex(ValueError, 'redirected'):
            await self.fetch(lambda request: httpx.Response(302, headers={'location':'/again'}))


if __name__ == '__main__':
    unittest.main()
