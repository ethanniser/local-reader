"""Opt-in, local-first replication to a paired Convex deployment.

Each field family has its own timestamp. Network requests never hold a SQLite
transaction, and pulls compare again under the write lock so listening during a
sync cannot be overwritten by an older remote snapshot.
"""
import asyncio
import hashlib
import json
import math
import re
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

import httpx

from . import library

_STATUS = {'enabled': False, 'state': 'disabled', 'lastSync': None, 'error': None, 'documents': 0, 'pendingImages': 0, 'warning': None}
_LOCK = asyncio.Lock()
MAX_JSON = 20 * 1024 * 1024


def validate_config(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid sync configuration.')
    url, token = value.get('url'), value.get('token')
    if not isinstance(url, str) or not isinstance(token, str) or not token or len(token) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise ValueError('Invalid sync configuration.')
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or not re.fullmatch(r'[a-z0-9-]+\.convex\.site', parsed.hostname or '')
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('Sync requires a paired HTTPS Convex site.')
    return {'url': url.rstrip('/'), 'token': token}


def load_config():
    path = library.DATA / 'sync.json'
    if not path.exists():
        return None
    return validate_config(json.loads(path.read_text()))


def sync_status():
    return dict(_STATUS)


def _stamp(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError('Invalid cloud timestamp.')
    return float(value)


def _setup_cache():
    with library.connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS sync_assets(site TEXT,asset TEXT,local_src TEXT,remote_src TEXT,PRIMARY KEY(site,asset))')
        db.execute('CREATE TABLE IF NOT EXISTS sync_pending_images(site TEXT,document_id TEXT,content_updated REAL,PRIMARY KEY(site,document_id))')


class CloudNotFound(ValueError):
    pass


class Cloud:
    def __init__(self, config, client):
        self.url, self.token, self.client = config['url'], config['token'], client
        # A newly paired identity on the same deployment must not reuse another
        # identity's storage IDs. Persist only a one-way cache namespace.
        self.scope = self.url + '#' + hashlib.sha256(self.token.encode()).hexdigest()

    async def request(self, method, path, *, body=None, content=None, limit=MAX_JSON, media=None):
        # Only fixed endpoint paths and validated image IDs reach this method.
        if not path.startswith('/') or path.startswith('//'):
            raise ValueError('Invalid cloud endpoint.')
        headers = {'Authorization': 'Bearer ' + self.token, 'Accept-Encoding': 'identity'}
        if media:
            headers['Content-Type'] = media
        async with self.client.stream(method, self.url + path, headers=headers, json=body, content=content,
                                      follow_redirects=False) as response:
            if response.status_code == 404:
                raise CloudNotFound('Cloud document not found.')
            if not 200 <= response.status_code < 300:
                raise ValueError('Cloud sync request failed.')
            if response.headers.get('content-encoding', 'identity').lower() not in ('', 'identity'):
                raise ValueError('Unsupported cloud response encoding.')
            result = bytearray()
            async for chunk in response.aiter_raw():
                if len(result) + len(chunk) > limit:
                    raise ValueError('Cloud response is too large.')
                result.extend(chunk)
        return bytes(result)

    async def json(self, method, path, body=None):
        raw = await self.request(method, path, body=body)
        return json.loads(raw) if raw else {}

    def remote_image(self, src):
        if not isinstance(src, str):
            raise ValueError('Invalid cloud image.')
        parsed = urlsplit(src)
        if parsed.scheme or parsed.netloc or parsed.path != '/images' or parsed.fragment:
            raise ValueError('Invalid cloud image.')
        query = parse_qs(parsed.query, strict_parsing=True)
        if set(query) != {'id'} or len(query['id']) != 1 or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', query['id'][0]):
            raise ValueError('Invalid cloud image.')
        return '/images?id=' + query['id'][0]

    async def upload_image(self, image):
        from . import images
        src = image.get('src', '')
        if not re.fullmatch(r'/api/images/[a-f0-9]{64}\.(png|jpg|webp|gif)', src):
            raise ValueError('Article image is not stored locally.')
        local_file = images.IMAGE_ROOT / src.rsplit('/', 1)[1]
        content = local_file.read_bytes()
        extension = images.verify_image(content)
        digest = hashlib.sha256(content).hexdigest()
        with library.connect() as db:
            cached = db.execute('SELECT remote_src FROM sync_assets WHERE site=? AND asset=?', (self.scope, digest)).fetchone()
        remote = cached['remote_src'] if cached else None
        if not remote:
            media = {'jpg':'image/jpeg', 'png':'image/png', 'webp':'image/webp', 'gif':'image/gif'}[extension]
            result = json.loads(await self.request('POST', '/images', content=content, media=media))
            remote = self.remote_image(result['url'])
            with library.connect() as db:
                db.execute('INSERT OR REPLACE INTO sync_assets VALUES(?,?,?,?)', (self.scope, digest, src, remote))
        return {**image, 'src': remote}

    async def download_image(self, image):
        from . import images
        src = self.remote_image(image.get('src'))
        with library.connect() as db:
            cached = db.execute('SELECT local_src FROM sync_assets WHERE site=? AND remote_src=?', (self.scope, src)).fetchone()
        local = cached['local_src'] if cached else None
        if not local or not (images.IMAGE_ROOT / local.rsplit('/', 1)[1]).is_file():
            content = await self.request('GET', src, limit=images.MAX_BYTES)
            local = await asyncio.to_thread(images.store_image, content)
            digest = hashlib.sha256(content).hexdigest()
            with library.connect() as db:
                db.execute('INSERT OR REPLACE INTO sync_assets VALUES(?,?,?,?)', (self.scope, digest, local, src))
        return {**image, 'src': local}


def _summary(row):
    return {**dict(row), 'metadataUpdated': row['metadata_updated'], 'contentUpdated': row['content_updated'], 'readUpdated': row['read_updated']}


def _local_rows():
    with library.connect() as db:
        return {row['id']: _summary(row) for row in db.execute('SELECT * FROM documents')}


def _remote_summary(item):
    if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', item['id']):
        raise ValueError('Invalid cloud document.')
    if not isinstance(item.get('title'), str) or not 1 <= len(item['title']) <= 300 or not isinstance(item.get('source', ''), str):
        raise ValueError('Invalid cloud article metadata.')
    source = item.get('source', '')
    if source:
        parsed = urlsplit(source)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or '@' in parsed.netloc:
            raise ValueError('Invalid cloud article source.')
    result = {**item, 'source': source}
    for key in ('updated', 'metadataUpdated', 'contentUpdated', 'readUpdated', 'lifecycleUpdated'):
        result[key] = _stamp(item.get(key, 0))
    if type(item.get('unread', True)) is not bool:
        raise ValueError('Invalid cloud read status.')
    result['unread'] = item.get('unread', True)
    for key in ('archived', 'deleted'):
        if type(item.get(key, False)) is not bool:
            raise ValueError('Invalid cloud lifecycle state.')
        result[key] = item.get(key, False)
    result['tags'] = library.normalize_tags(item.get('tags', []))
    if not isinstance(item.get('position', 0), int) or item.get('position', 0) < 0:
        raise ValueError('Invalid cloud reading position.')
    result['position'] = item.get('position', 0)
    return result


def _content(remote):
    words, blocks, images = remote.get('words'), remote.get('paragraphs'), remote.get('images', [])
    if not isinstance(words, list) or not 1 <= len(words) <= 250000 or any(not isinstance(w, str) or len(w) > 100000 for w in words):
        raise ValueError('Invalid cloud article text.')
    if not isinstance(blocks, list) or len(blocks) > 250000:
        raise ValueError('Invalid cloud paragraphs.')
    for p in blocks:
        if (not isinstance(p, dict) or not isinstance(p.get('start'), int) or not isinstance(p.get('end'), int)
                or not 0 <= p['start'] < p['end'] <= len(words) or p.get('kind') not in ('paragraph', 'heading', 'blockquote')):
            raise ValueError('Invalid cloud paragraphs.')
    if not isinstance(images, list) or len(images) > 20:
        raise ValueError('Invalid cloud images.')
    for image in images:
        if not isinstance(image, dict) or not isinstance(image.get('position', 0), int) or not 0 <= image.get('position', 0) <= len(words):
            raise ValueError('Invalid cloud image position.')
    from .formatting import normalize_marks
    marks = normalize_marks(remote.get('marks', []), len(words))
    return {'words': words, 'paragraphs': blocks, 'images': images, 'marks': marks, 'formatVersion': 2}


async def _pull_content(cloud, remote):
    full = _remote_summary(await cloud.json('GET', '/documents?id=' + remote['id'] + '&format=2'))
    if full['id'] != remote['id']:
        raise ValueError('Cloud document identity mismatch.')
    content = _content(full)
    localized = []
    full['_images_incomplete'] = False
    for item in content['images']:
        try:
            localized.append(await cloud.download_image(item))
        except Exception:
            # A bad, missing or temporarily unavailable image must not block text,
            # reading progress, tags, or the remaining articles. Persist a retry
            # marker atomically with the content so images are not silently lost.
            full['_images_incomplete'] = True
    content['images'] = localized
    full['_content'] = content
    return full


def _retry_scope(scope):
    # Retry intent is not an asset credential: preserve it across token rotation
    # while still fetching through the newly authenticated deployment.
    return scope.rsplit('#', 1)[0] + '#%'


def _record_image_retry(db, scope, full):
    db.execute('DELETE FROM sync_pending_images WHERE site LIKE ? AND document_id=?', (_retry_scope(scope), full['id']))
    if full.get('_images_incomplete'):
        db.execute('INSERT OR REPLACE INTO sync_pending_images VALUES(?,?,?)', (scope, full['id'], full['contentUpdated']))


def _needs_format_refresh(row):
    content = json.loads(row['content'])
    return 'marks' not in content or content.get('formatVersion', 0) != 2


def _merge(remote, full=None, scope=''):
    # Full document can be newer than the manifest; choose each field family independently.
    metadata = max([remote, full] if full else [remote], key=lambda d:d['metadataUpdated'])
    progress = max([remote, full] if full else [remote], key=lambda d:d['updated'])
    read_status = max([remote, full] if full else [remote], key=lambda d:d['readUpdated'])
    lifecycle = max([remote, full] if full else [remote], key=lambda d:d['lifecycleUpdated'])
    # An accepted cloud tombstone is permanent, even if another device's clock
    # is ahead due to an unsynced archive choice.
    deleted = next((d for d in ([remote, full] if full else [remote]) if d['deleted']), None)
    # Re-read after network/image downloads: user progress or tags may have changed.
    with library.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT * FROM documents WHERE id=?', (remote['id'],)).fetchone()
        if deleted:
            if row:
                db.execute('UPDATE documents SET deleted=1,archived=?,lifecycle_updated=MAX(lifecycle_updated,?) WHERE id=?', (int(deleted['archived']),deleted['lifecycleUpdated'],remote['id']))
            else:
                content = json.dumps({'words':[], 'paragraphs':[], 'images':[], 'marks':[], 'formatVersion':2})
                db.execute('INSERT INTO documents(id,title,collection,source,unread,content,words,tags,deleted,archived,lifecycle_updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)', (remote['id'],metadata['title'],'Your documents',metadata['source'],int(read_status['unread']),content,0,json.dumps(metadata['tags']),1,int(deleted['archived']),deleted['lifecycleUpdated']))
            db.execute('DELETE FROM sync_pending_images WHERE document_id=?', (remote['id'],))
            return
        if row and row['deleted']:
            return
        if not row:
            if not full:
                return
            content = full['_content']
            db.execute('INSERT INTO documents(id,title,collection,source,unread,content,words,position,updated,tags,metadata_updated,content_updated,read_updated,archived,deleted,lifecycle_updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (full['id'], metadata['title'], 'Your documents', metadata['source'], int(read_status['unread']), json.dumps(content, ensure_ascii=False),
                        len(content['words']), min(progress['position'], len(content['words'])-1), progress['updated'], json.dumps(metadata['tags']), metadata['metadataUpdated'], full['contentUpdated'], read_status['readUpdated'],int(lifecycle['archived']),0,lifecycle['lifecycleUpdated']))
            _record_image_retry(db, scope, full)
            return
        retry = db.execute('SELECT MAX(content_updated) AS content_updated FROM sync_pending_images WHERE site LIKE ? AND document_id=? HAVING COUNT(*)>0', (_retry_scope(scope), remote['id'])).fetchone()
        if full and (full['contentUpdated'] > row['content_updated'] or ((retry or _needs_format_refresh(row)) and full['contentUpdated'] == row['content_updated'])):
            content = full['_content']
            db.execute('UPDATE documents SET content=?,words=?,content_updated=?,position=MIN(position,?) WHERE id=?',
                       (json.dumps(content, ensure_ascii=False), len(content['words']), full['contentUpdated'], len(content['words'])-1, remote['id']))
            _record_image_retry(db, scope, full)
        elif retry and row['content_updated'] > retry['content_updated']:
            db.execute('DELETE FROM sync_pending_images WHERE site LIKE ? AND document_id=?', (_retry_scope(scope), remote['id']))
        db.execute('UPDATE documents SET archived=?,lifecycle_updated=? WHERE id=? AND lifecycle_updated<?', (int(lifecycle['archived']),lifecycle['lifecycleUpdated'],remote['id'],lifecycle['lifecycleUpdated']))
        db.execute('UPDATE documents SET title=?,source=?,tags=?,metadata_updated=? WHERE id=? AND metadata_updated<?',
                   (metadata['title'], metadata['source'], json.dumps(metadata['tags'], ensure_ascii=False), metadata['metadataUpdated'], remote['id'], metadata['metadataUpdated']))
        db.execute('UPDATE documents SET unread=?,read_updated=? WHERE id=? AND read_updated<?',
                   (int(read_status['unread']), read_status['readUpdated'], remote['id'], read_status['readUpdated']))
        db.execute('UPDATE documents SET position=MIN(?,words-1),updated=? WHERE id=? AND updated<?',
                   (progress['position'], progress['updated'], remote['id'], progress['updated']))


async def _sync(config, client):
    _setup_cache()
    cloud = Cloud(config, client)
    manifest = await cloud.json('GET', '/sync?format=2')
    if not isinstance(manifest, dict) or not isinstance(manifest.get('documents'), list):
        raise ValueError('Invalid cloud manifest.')
    remote = {item['id']: item for item in map(_remote_summary, manifest['documents'])}
    local = _local_rows()
    with library.connect() as db:
        pending = {r['document_id']:r['content_updated'] for r in db.execute('SELECT document_id,MAX(content_updated) AS content_updated FROM sync_pending_images WHERE site LIKE ? GROUP BY document_id', (_retry_scope(cloud.scope),))}
    for doc_id, item in remote.items():
        row = local.get(doc_id)
        # Old desktop versions discarded marks or quote kinds without changing
        # the content clock. Refresh those caches once, without manufacturing a new version.
        refresh_format = row is not None and _needs_format_refresh(row) and item['contentUpdated'] == row['content_updated']
        needs_content = row is None or item['contentUpdated'] > row['content_updated'] or refresh_format or (doc_id in pending and row['content_updated'] <= pending[doc_id])
        if item['deleted'] or row is not None and row['deleted']:
            _merge(item, scope=cloud.scope)
            continue
        try:
            full = await _pull_content(cloud, item) if needs_content else None
        except CloudNotFound:
            # Deletion may land after the manifest. Continue other articles; the
            # next manifest will supply its tombstone. Never manufacture content.
            continue
        _merge(item, full, cloud.scope)
    # Fresh snapshot includes edits made while pulling and newly pulled documents.
    for doc_id, row in _local_rows().items():
        item = remote.get(doc_id)
        state = {'id':doc_id,'archived':bool(row['archived']),'deleted':bool(row['deleted']),'lifecycleUpdated':row['lifecycle_updated']}
        if row['deleted']:
            with library.connect() as db:
                db.execute('DELETE FROM sync_pending_images WHERE document_id=?', (doc_id,))
                # Deletion is permanent locally. If an unseen archive edit had a
                # newer clock, restamp this pending delete after observing it so
                # strict LWW on the server converges rather than retrying forever.
                if item is not None and not item['deleted'] and state['lifecycleUpdated'] <= item['lifecycleUpdated']:
                    state['lifecycleUpdated'] = max(time.time(), item['lifecycleUpdated'] + 0.000001)
                    db.execute('UPDATE documents SET lifecycle_updated=? WHERE id=? AND deleted=1', (state['lifecycleUpdated'],doc_id))
            if item is None or not item['deleted']:
                await cloud.json('PUT', '/lifecycle', state)
            continue
        if item is not None and row['lifecycle_updated'] > item['lifecycleUpdated']:
            await cloud.json('PUT', '/lifecycle', state)
        metadata_changed = item is not None and row['metadata_updated'] > item['metadataUpdated'] and (row['title'] != item['title'] or row['source'] != item['source'])
        if item is None or row['content_updated'] > item['contentUpdated'] or metadata_changed:
            content = json.loads(row['content'])
            content.setdefault('marks', [])
            content['images'] = [await cloud.upload_image(image) for image in content.get('images', [])]
            await cloud.json('POST', '/documents', {**content, 'id':doc_id, 'title':row['title'], 'source':row['source'],
                'tags':json.loads(row['tags']), 'position':row['position'], 'updated':row['updated'],
                'metadataUpdated':row['metadata_updated'], 'contentUpdated':row['content_updated'],
                'unread':bool(row['unread']), 'readUpdated':row['read_updated'],
                'archived':bool(row['archived']), 'deleted':False, 'lifecycleUpdated':row['lifecycle_updated']})
        else:
            if row['metadata_updated'] > item['metadataUpdated']:
                await cloud.json('PUT', '/tags', {'id':doc_id, 'tags':json.loads(row['tags']), 'metadataUpdated':row['metadata_updated']})
            if row['read_updated'] > item['readUpdated']:
                await cloud.json('PUT', '/read-status', {'id':doc_id, 'unread':bool(row['unread']), 'readUpdated':row['read_updated']})
            if row['updated'] > item['updated']:
                await cloud.json('PUT', '/progress', {'id':doc_id, 'position':row['position'], 'updated':row['updated']})
    with library.connect() as db:
        pending_count = db.execute('SELECT COUNT(DISTINCT document_id) FROM sync_pending_images WHERE site LIKE ?', (_retry_scope(cloud.scope),)).fetchone()[0]
    return len(library.list_documents()), pending_count


async def sync_once(*, client=None):
    async with _LOCK:
        try:
            config = load_config()
            if config is None:
                _STATUS.update(enabled=False, state='disabled', error=None, pendingImages=0, warning=None)
                return sync_status()
            _STATUS.update(enabled=True, state='syncing', error=None)
            if client is None:
                async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False) as owned:
                    count, pending_count = await _sync(config, owned)
            else:
                count, pending_count = await _sync(config, client)
            _STATUS.update(state='ready', lastSync=time.time(), documents=count, error=None, pendingImages=pending_count,
                           warning='Some article images are unavailable and will be retried.' if pending_count else None)
        except asyncio.CancelledError:
            _STATUS.update(state='idle')
            raise
        except Exception:
            # Never expose exception URLs, response text, or bearer credentials.
            _STATUS.update(state='error', error='Sync unavailable. Your local library is safe; retry when connected.')
        return sync_status()


async def sync_loop(stop_event=None):
    while stop_event is None or not stop_event.is_set():
        await sync_once()
        if stop_event is None:
            await asyncio.sleep(20)
        else:
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=20)
            except TimeoutError:
                pass
