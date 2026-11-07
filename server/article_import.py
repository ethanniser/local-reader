"""Import public web articles without browser credentials or private-network access."""
import asyncio
import ipaddress
import re
import socket
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag
from .formatting import inline_text, block_kind

MAX_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 5
BROWSER_HINT = 'For subscriber-only or JavaScript pages, use Import open page in Chrome.'


def normalize_url(value):
    try:
        url = httpx.URL(value.strip())
        if (url.scheme not in ('http', 'https') or not url.host or url.userinfo
                or url.port not in (None, 80, 443)):
            raise ValueError
        return url.copy_with(fragment=None)
    except (httpx.InvalidURL, ValueError):
        raise ValueError('Enter a public http:// or https:// article URL (without a login or custom port).') from None


async def public_address(url):
    """Resolve once, reject mixed public/private answers, then connect to the IP."""
    try:
        records = await asyncio.get_running_loop().getaddrinfo(
            url.host, url.port or (443 if url.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    except OSError:
        raise ValueError('Could not find that website. Check the link and your connection.') from None
    addresses = list(dict.fromkeys(record[4][0] for record in records))
    def is_public(value):
        address = ipaddress.ip_address(value)
        if not address.is_global or address.is_multicast or address.is_reserved:
            return False
        if isinstance(address, ipaddress.IPv6Address):
            # Reject transition mechanisms which could tunnel to a private IPv4 host.
            for embedded in (address.ipv4_mapped, address.sixtofour):
                if embedded and not embedded.is_global:
                    return False
            if address.teredo:
                return False
        return True
    if not addresses or any(not is_public(value) for value in addresses):
        raise ValueError('Only public website links can be imported. Local and private addresses are blocked.')
    return addresses[0]


def extract_html(html, source=''):
    soup = BeautifulSoup(html, 'html.parser')
    title_node = soup.select_one('meta[property="og:title"]')
    title = title_node.get('content', '') if title_node else ''
    if not title:
        node = soup.find('h1') or soup.find('title')
        title = node.get_text(' ', strip=True) if node else 'Imported article'
    title = re.sub(r'\s+', ' ', title).strip()[:300] or 'Imported article'
    for node in soup.select('script,style,noscript,nav,footer,aside,form,button,svg,iframe,[hidden],[aria-hidden="true"]'):
        node.decompose()
    # Prefer article semantics; choose the largest article if there are cards too.
    candidates = (soup.select('[itemprop="articleBody"]') or soup.select('article')
                  or soup.select('main, [role="main"]'))
    def score(node):
        paragraphs = node.find_all('p')
        return sum(len(p.get_text(' ', strip=True)) for p in paragraphs) or len(node.get_text(' ', strip=True))
    root = max(candidates, key=score) if candidates else soup.body or soup
    for node in root.select('header'):
        # Article headers may contain the real heading/deck; only discard navigation.
        if not node.find(['h1', 'h2', 'p']):
            node.decompose()
    blocks, images = [], []
    accepted = {}
    count = 0
    block_names = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre'}
    for node in root.descendants:
        if not isinstance(node, Tag):
            continue
        if node.name in block_names and not node.find(['p', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
            text, marks = inline_text(node, source)
            if text:
                accepted[id(node)] = count
                blocks.append({'text': text, 'kind': block_kind(node), **({'marks':marks} if marks else {})})
                count += len(text.split())
        if node.name == 'img':
            src = node.get('data-src') or node.get('data-original') or ''
            srcset = node.get('data-srcset') or node.get('srcset') or ''
            if not src and srcset and not srcset.lstrip().startswith('data:'):
                choices = []
                for choice in srcset.split(','):
                    parts = choice.strip().split()
                    if parts:
                        try:
                            weight = float(parts[-1][:-1]) if len(parts) > 1 else 1
                        except ValueError:
                            weight = 1
                        choices.append((weight, parts[0]))
                if choices:
                    src = max(choices, key=lambda item: item[0])[1]
            src = src or node.get('src') or ''
            if not src:
                continue
            position = count
            for ancestor in node.parents:
                if id(ancestor) in accepted:
                    prefix = []
                    for child in ancestor.descendants:
                        if child is node:
                            break
                        if isinstance(child, NavigableString):
                            prefix.append(str(child))
                    position = accepted[id(ancestor)] + len(''.join(prefix).split())
                    break
            figure = node.find_parent('figure')
            caption = figure.find('figcaption').get_text(' ', strip=True) if figure and figure.find('figcaption') else ''
            images.append({'src': urljoin(source, src), 'alt': str(node.get('alt', ''))[:1000],
                           'caption': caption[:2000], 'position': position})
    if not blocks:
        text, marks = inline_text(root, source)
        blocks = [{'text': text, 'kind': 'paragraph', **({'marks':marks} if marks else {})}] if text else []
    article_text = re.sub(r'\s+', ' ', ' '.join(block['text'] for block in blocks))
    for image in images:
        if image['caption'] and re.sub(r'\s+', ' ', image['caption']) in article_text:
            image['caption'] = ''  # Caption is already retained in the reading text.
    count = sum(len(block['text'].split()) for block in blocks)
    if count < 20:
        raise ValueError('This page did not provide enough readable article text. ' + BROWSER_HINT)
    return {'title': title, 'blocks': blocks, 'source': source, 'images': images}


async def _import_url(value):
    url = normalize_url(value)
    # Environment proxies must not bypass the destination checks.
    for hop in range(MAX_REDIRECTS + 1):
        address = await public_address(url)
        # Separate pools prevent reusing TLS authenticated for another hostname on a shared IP.
        async with httpx.AsyncClient(timeout=httpx.Timeout(15), trust_env=False, follow_redirects=False) as client:
            # Keep original Host and TLS certificate/SNI identity, but never resolve again.
            pinned = url.copy_with(host=address)
            async with client.stream('GET', pinned, headers={
                'Host': url.netloc.decode('ascii'),
                'User-Agent': 'LocalReader/1.0 (personal article import)',
                'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.8',
                'Accept-Encoding': 'identity',
            }, extensions={'sni_hostname': url.host}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get('location')
                    if not location or hop == MAX_REDIRECTS:
                        raise ValueError('The website redirected too many times or returned an invalid redirect.')
                    url = normalize_url(urljoin(str(url), location))
                    continue
                if response.status_code >= 400:
                    raise ValueError(f'The website refused the import (HTTP {response.status_code}). ' + BROWSER_HINT)
                content_type = response.headers.get('content-type', '').split(';')[0].strip().lower()
                if content_type not in ('text/html', 'application/xhtml+xml', 'text/plain'):
                    raise ValueError('That link is not an HTML article or text page. Download the file and use file import.')
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > MAX_BYTES:
                        raise ValueError('This page is too large to import (maximum 5 MB).')
                encoding = response.encoding or 'utf-8'
                try:
                    text = bytes(chunks).decode(encoding, errors='replace')
                except LookupError:
                    text = bytes(chunks).decode('utf-8', errors='replace')
                if content_type == 'text/plain':
                    from html import escape
                    text = '<pre>' + escape(text) + '</pre>'
                return await asyncio.to_thread(extract_html, text, str(url))


async def import_url(value):
    try:
        # Also cap slow trickles and DNS waits, beyond per-operation HTTP timeouts.
        return await asyncio.wait_for(_import_url(value), timeout=45)
    except (httpx.HTTPError, OSError, TimeoutError):
        raise ValueError('Could not download this page. Check your connection or use Import open page in Chrome.') from None
