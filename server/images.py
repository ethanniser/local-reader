"""Bounded, offline raster image storage for imported articles."""
import asyncio
import base64
import binascii
import hashlib
import io
import re
import tempfile
from pathlib import Path
from urllib.parse import urljoin
import warnings

import httpx
from PIL import Image

from .article_import import normalize_url, public_address, MAX_REDIRECTS
from .library import DATA

IMAGE_ROOT = DATA / 'images'
MAX_IMAGES = 20
MAX_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MAX_PIXELS = 24_000_000
FORMATS = {'PNG': 'png', 'JPEG': 'jpg', 'WEBP': 'webp', 'GIF': 'gif'}


def verify_image(content):
    if len(content) > MAX_BYTES:
        raise ValueError('image exceeds 5 MB')
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(content)) as image:
            extension = FORMATS.get(image.format)
            if not extension or image.width * image.height > MAX_PIXELS:
                raise ValueError('unsupported or oversized image')
            image.verify()
    return extension


async def fetch_image(src):
    if src.startswith('data:'):
        match = re.fullmatch(r'data:image/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)', src)
        if not match or len(match[1]) > (MAX_BYTES + 2) // 3 * 4:
            raise ValueError('unsupported or oversized embedded image')
        try:
            return base64.b64decode(match[1], validate=True)
        except (binascii.Error, ValueError):
            raise ValueError('invalid embedded image') from None
    if len(src) > 8192:
        raise ValueError('image URL is too long')
    url = normalize_url(src)
    for hop in range(MAX_REDIRECTS + 1):
        address = await public_address(url)
        async with httpx.AsyncClient(timeout=8, trust_env=False, follow_redirects=False) as client:
            async with client.stream('GET', url.copy_with(host=address), headers={
                'Host': url.netloc.decode('ascii'), 'Accept': 'image/png,image/jpeg,image/webp,image/gif',
                'Accept-Encoding': 'identity', 'User-Agent': 'LocalReader/1.0 (personal article import)',
            }, extensions={'sni_hostname': url.host}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    target = response.headers.get('location')
                    if not target or hop == MAX_REDIRECTS:
                        raise ValueError('image redirect failed')
                    url = normalize_url(urljoin(str(url), target))
                    continue
                response.raise_for_status()
                # Never decompress an arbitrarily large compressed response first.
                if response.headers.get('content-encoding', 'identity').lower() not in ('', 'identity'):
                    raise ValueError('compressed image response is unsupported')
                content = bytearray()
                async for chunk in response.aiter_raw():
                    if len(content) + len(chunk) > MAX_BYTES:
                        raise ValueError('image exceeds 5 MB')
                    content.extend(chunk)
                return bytes(content)
    raise ValueError('image could not be downloaded')


def store_image(content):
    extension = verify_image(content)
    filename = hashlib.sha256(content).hexdigest() + '.' + extension
    IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
    target = IMAGE_ROOT / filename
    if not target.exists():
        with tempfile.NamedTemporaryFile(dir=IMAGE_ROOT, delete=False) as temp:
            temporary = Path(temp.name)
            try:
                temp.write(content)
                temp.flush()
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    return '/api/images/' + filename


async def save_images(images):
    """An unavailable image must never prevent importing an article's text."""
    saved, notices = [], []
    total_bytes = 0
    deadline = asyncio.get_running_loop().time() + 45
    if len(images) > MAX_IMAGES:
        notices.append('Only the first 20 article images were saved.')
    for item in images[:MAX_IMAGES]:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            notices.append('Some images could not be saved before the download timed out.')
            break
        try:
            src = item['src']
            if not isinstance(src, str):
                raise ValueError('invalid source')
            content = await asyncio.wait_for(fetch_image(src), timeout=min(10, remaining))
            if total_bytes + len(content) > MAX_TOTAL_BYTES:
                notices.append('Some images were skipped to keep this article under 30 MB of images.')
                break
            local_src = await asyncio.to_thread(store_image, content)
            total_bytes += len(content)
            saved.append({'src': local_src, 'alt': str(item.get('alt', ''))[:1000],
                          'caption': str(item.get('caption', ''))[:2000],
                          'position': max(0, int(item.get('position', 0)))})
        except (ValueError, TypeError, KeyError, OSError, SyntaxError, OverflowError, httpx.HTTPError, TimeoutError,
                Image.DecompressionBombError, Image.DecompressionBombWarning):
            notices.append('An image could not be saved; the article text was kept.')
    return saved, list(dict.fromkeys(notices))
