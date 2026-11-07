import asyncio
import base64
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image
from server import images
from server.article_import import extract_html


def png():
    buffer = io.BytesIO()
    Image.new('RGB', (3, 2), 'green').save(buffer, format='PNG')
    return buffer.getvalue()


class ImageExtractionTests(unittest.TestCase):
    def test_order_relative_lazy_and_inline_images(self):
        text = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.'
        result = extract_html(f'<article><h1>Story</h1><p>Before <img src="/inline.png" alt="Inside"> after.</p><figure><img data-src="image.jpg"><figcaption>A caption</figcaption></figure><p>{text}</p><img srcset="small.png 300w, large.png 1200w"></article>', 'https://example.org/read/')
        self.assertEqual([i['position'] for i in result['images']], [2, 3, 23])
        self.assertEqual(result['images'][0]['src'], 'https://example.org/inline.png')
        self.assertEqual(result['images'][1]['src'], 'https://example.org/read/image.jpg')
        self.assertEqual(result['images'][1]['caption'], 'A caption')
        self.assertEqual(result['images'][2]['src'], 'https://example.org/read/large.png')


class ImageStorageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(images, 'IMAGE_ROOT', Path(self.temp.name))
        self.root_patch.start()

    async def asyncTearDown(self):
        self.root_patch.stop()
        self.temp.cleanup()

    async def test_embedded_image_saved_offline(self):
        data = png()
        src = 'data:image/png;base64,' + base64.b64encode(data).decode()
        saved, warnings = await images.save_images([{'src':src, 'position':2, 'alt':'Diagram', 'caption':'Caption'}])
        self.assertFalse(warnings)
        self.assertEqual(saved[0]['position'], 2)
        path = Path(self.temp.name) / saved[0]['src'].split('/')[-1]
        self.assertEqual(path.read_bytes(), data)
        self.assertEqual(saved[0]['alt'], 'Diagram')
        again, _ = await images.save_images([{'src':src}])
        self.assertEqual(again[0]['src'], saved[0]['src'])
        self.assertEqual(len(list(Path(self.temp.name).iterdir())), 1)

    async def test_failures_preserve_other_images(self):
        src = 'data:image/png;base64,' + base64.b64encode(png()).decode()
        saved, warnings = await images.save_images([{'src':'data:image/svg+xml,<svg/>'}, {'src':src}, {'src':'file:///etc/passwd'}])
        self.assertEqual(len(saved), 1)
        self.assertTrue(warnings)

    async def test_byte_and_pixel_limits(self):
        with self.assertRaises(ValueError):
            images.verify_image(b'x' * (images.MAX_BYTES+1))
        with patch.object(images, 'MAX_PIXELS', 2):
            with self.assertRaises(ValueError):
                images.verify_image(png())
        with patch.object(images, 'MAX_TOTAL_BYTES', 1):
            with patch.object(images, 'fetch_image', AsyncMock(return_value=png())):
                saved, warnings = await images.save_images([{'src':'https://example.org/image.png'}])
                self.assertFalse(saved)
                self.assertTrue(warnings)

    async def test_nonimage_data_rejected(self):
        src = 'data:image/png;base64,' + base64.b64encode(b'<html>bad</html>').decode()
        saved, warnings = await images.save_images([{'src':src}])
        self.assertFalse(saved)
        self.assertTrue(warnings)

    async def test_private_destination_rejected(self):
        with patch.object(images, 'public_address', AsyncMock(side_effect=ValueError('private'))):
            saved, warnings = await images.save_images([{'src':'http://127.0.0.1/private'}])
        self.assertFalse(saved)
        self.assertTrue(warnings)

    async def test_public_raster_download(self):
        real_client = httpx.AsyncClient
        def handler(request):
            return httpx.Response(200, stream=httpx.ByteStream(png()), headers={'content-type':'image/png'})
        with patch.object(images, 'public_address', AsyncMock(return_value='93.184.216.34')), patch.object(images.httpx, 'AsyncClient', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)):
            saved, warnings = await images.save_images([{'src':'https://example.org/image'}])
        self.assertEqual(len(saved), 1)
        self.assertFalse(warnings)

    async def test_redirect_is_revalidated(self):
        real_client = httpx.AsyncClient
        address = AsyncMock(side_effect=['93.184.216.34', ValueError('private')])
        def handler(request):
            self.assertEqual(request.url.host, '93.184.216.34')
            self.assertEqual(request.headers['host'], 'example.org')
            self.assertEqual(request.extensions['sni_hostname'], 'example.org')
            return httpx.Response(302, headers={'location':'http://127.0.0.1/private'})
        with patch.object(images, 'public_address', address), patch.object(images.httpx, 'AsyncClient', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)):
            saved, warnings = await images.save_images([{'src':'https://example.org/image'}])
        self.assertFalse(saved)
        self.assertTrue(warnings)
        self.assertEqual(address.await_count, 2)


if __name__ == '__main__':
    unittest.main()
