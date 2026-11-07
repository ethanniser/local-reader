import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import hashlib
import io
import json
import logging
import subprocess
from pathlib import Path
import re
import time
import zipfile
from urllib.parse import urlsplit

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StrictBool
import soundfile as sf
from .library import update_lifecycle, initialize, document, connect, paragraphs, add_document, choose_chunk, DATA, list_documents, update_tags, update_read_status
from .backends import BackendManager, ffmpeg as ffmpeg_path

ROOT = Path(__file__).resolve().parent.parent
CACHE = DATA / 'audio'
CACHE.mkdir(exist_ok=True)
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='speech')
GATE = asyncio.Lock()
BACKENDS = BackendManager()


def boot():
    try:
        BACKENDS.prepare('kokoro')
    except Exception:
        logging.exception('Kokoro initialization failed; other backends remain available')


@asynccontextmanager
async def lifespan(app):
    initialize()
    asyncio.get_running_loop().run_in_executor(POOL, boot)
    from .cloud_sync import sync_loop
    sync_stop = asyncio.Event()
    sync_task = asyncio.create_task(sync_loop(sync_stop))
    yield
    sync_stop.set()
    sync_task.cancel()
    try:
        await sync_task
    except asyncio.CancelledError:
        pass
    POOL.shutdown(wait=True, cancel_futures=True)
    BACKENDS.close()


app = FastAPI(lifespan=lifespan)


@app.middleware('http')
async def local_only(request: Request, call_next):
    if request.headers.get('host', '').split(':')[0] not in ('127.0.0.1', 'localhost', 'testserver'):
        return JSONResponse({'detail': 'Local connections only'}, status_code=403)
    origin = request.headers.get('origin')
    if origin and origin not in ('http://127.0.0.1:8787', 'http://localhost:8787'):
        return JSONResponse({'detail': 'Cross-origin requests are disabled'}, status_code=403)
    return await call_next(request)


@app.get('/api/status')
def status(backend: str = 'kokoro'):
    if backend not in BACKENDS.definitions:
        raise HTTPException(422, 'Unknown speech engine')
    return {**BACKENDS.describe(backend), 'backends': BACKENDS.catalog(), 'local': True}


@app.get('/api/sync/status')
def sync_status_route():
    from .cloud_sync import sync_status
    return sync_status()


@app.post('/api/sync/now')
async def sync_now_route():
    from .cloud_sync import sync_once
    return await sync_once()


@app.get('/api/sync/pairing')
def sync_pairing():
    from .cloud_sync import load_config
    from urllib.parse import urlencode
    config = load_config()
    if not config:
        raise HTTPException(404, 'Cloud sync is not configured on this Mac.')
    # Only available through the loopback-only, same-origin reader UI.
    return JSONResponse({'url': config['url'], 'pairingURL': 'localreader://pair?' + urlencode(config)},
                        headers={'Cache-Control': 'no-store'})


@app.get('/api/library')
def library():
    return list_documents()


@app.get('/api/documents/{doc_id}')
def get_document(doc_id: str):
    result = document(doc_id)
    if not result:
        raise HTTPException(404, 'Document not found')
    return result


class Tags(BaseModel):
    tags: list[str] = Field(max_length=20)


@app.put('/api/documents/{doc_id}/tags')
def set_document_tags(doc_id: str, body: Tags):
    try:
        tags = update_tags(doc_id, body.tags)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if tags is None:
        raise HTTPException(404, 'Document not found')
    return {'tags': tags}


class ReadStatus(BaseModel):
    unread: StrictBool


@app.put('/api/documents/{doc_id}/read-status')
def set_document_read_status(doc_id: str, body: ReadStatus):
    result = update_read_status(doc_id, body.unread)
    if result is None:
        raise HTTPException(404, 'Document not found')
    return result


class ArchiveStatus(BaseModel):
    archived: StrictBool


@app.put('/api/documents/{doc_id}/archive')
def archive_document(doc_id: str, body: ArchiveStatus):
    result = update_lifecycle(doc_id, archived=body.archived)
    if result is None:
        raise HTTPException(404, 'Document not found')
    return result


@app.delete('/api/documents/{doc_id}')
def delete_document(doc_id: str):
    result = update_lifecycle(doc_id, deleted=True)
    if result is None:
        raise HTTPException(404, 'Document not found')
    return result


class Position(BaseModel):
    word: int = Field(ge=0)


@app.put('/api/documents/{doc_id}/progress')
def progress(doc_id: str, body: Position):
    with connect() as db:
        db.execute('UPDATE documents SET position=MIN(?,words-1),updated=? WHERE id=? AND deleted=0', (body.word, time.time(), doc_id))
    return {'ok': True}


class ArticleImage(BaseModel):
    src: str = Field(max_length=7_000_000)
    alt: str = Field(default='', max_length=2000)
    caption: str = Field(default='', max_length=4000)
    position: int = Field(default=0, ge=0, le=250000)


class Paste(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=2000000)
    source: str = Field(default='', max_length=4096)
    images: list[ArticleImage] = Field(default_factory=list, max_length=20)
    marks: list[dict] = Field(default_factory=list, max_length=50000)
    paragraphs: list[dict] | None = Field(default=None, max_length=250000)


@app.post('/api/import/text')
async def paste(body: Paste):
    try:
        if body.source and (urlsplit(body.source).scheme not in ('http', 'https') or not urlsplit(body.source).hostname or '@' in urlsplit(body.source).netloc):
            raise ValueError('Original link must be an HTTP or HTTPS URL without credentials.')
        if not body.title.strip():
            raise ValueError('Please give the article a title.')
        from .formatting import blocks_from_ranges, normalize_marks
        blocks = blocks_from_ranges(body.text, body.paragraphs) if body.paragraphs is not None else paragraphs(body.text)
        marks = normalize_marks(body.marks, len(re.findall(r'\S+', body.text)))
        from .images import save_images
        images, warnings = await save_images([image.model_dump() for image in body.images])
        return {'id': add_document(body.title.strip(), blocks, source=body.source, images=images, marks=marks), 'warnings': warnings}
    except ValueError as exc:
        raise HTTPException(422, str(exc))


class Link(BaseModel):
    url: str = Field(min_length=1, max_length=4096)


@app.post('/api/import/url')
async def import_link(body: Link):
    from .article_import import import_url
    try:
        article = await import_url(body.url)
        from .images import save_images
        images, warnings = await save_images(article.get('images', []))
        return {'id': add_document(article['title'], article['blocks'], source=article['source'], images=images), 'warnings': warnings}
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@app.get('/api/extension/download')
def extension_download():
    content = io.BytesIO()
    with zipfile.ZipFile(content, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((ROOT / 'extension').rglob('*')):
            if path.is_file() and path.suffix in ('.json', '.js', '.html', '.css', '.md', '.png', '.svg'):
                archive.write(path, Path('local-reader-extension') / path.relative_to(ROOT / 'extension'))
    return Response(content.getvalue(), media_type='application/zip',
                    headers={'Content-Disposition': 'attachment; filename="local-reader-extension.zip"'})


@app.post('/api/import/file')
async def upload(file: UploadFile = File(...)):
    contents = await file.read(20 * 1024 * 1024 + 1)
    await file.close()
    if len(contents) > 20 * 1024 * 1024:
        raise HTTPException(413, 'Please keep files under 20 MB.')
    filename = Path(file.filename or 'Untitled.txt').name
    ext = Path(filename).suffix.lower().lstrip('.')
    if ext not in ('txt', 'md', 'markdown', 'html', 'htm', 'pdf'):
        raise HTTPException(422, 'Choose a TXT, Markdown, HTML, or text-based PDF file.')
    def parse():
        if ext == 'pdf':
            from pypdf import PdfReader
            text = '\n\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(contents)).pages)
            blocks = paragraphs(text)
        else:
            blocks = paragraphs(contents.decode('utf-8-sig', errors='replace'), ext)
        return add_document(Path(filename).stem, blocks)
    try:
        return {'id': await asyncio.to_thread(parse)}
    except Exception as exc:
        raise HTTPException(422, f'Could not import this file: {exc}')


class Chunk(BaseModel):
    document: str
    start: int = Field(ge=0)
    voice: str = 'af_heart'
    backend: str = 'kokoro'
    speed: float = Field(default=1, ge=0.5, le=4.0)


def generate(body, doc):
    words = doc['words']
    end = choose_chunk(words, body.start)
    while True:
        try:
            audio, times, native_speed = BACKENDS.render(body.backend, words[body.start:end], body.voice, body.speed)
            break
        except ValueError:
            if body.backend != 'kokoro' or end <= body.start + 1:
                raise
            end = body.start + max(1, (end-body.start)//2)
    if abs(body.speed - native_speed) > 0.001:
        # Time-stretch faster settings without raising pitch or forcing the
        # model's phoneme durations below their useful minimum.
        import numpy as np
        tempo = body.speed / native_speed
        filters = []
        while tempo > 2:
            filters.append('atempo=2')
            tempo /= 2
        filters.append(f'atempo={tempo:.8f}')
        transformed = subprocess.run([ffmpeg_path(), '-v', 'error', '-f', 'f32le', '-ar', '24000', '-ac', '1',
            '-i', 'pipe:0', '-af', ','.join(filters), '-f', 'f32le', 'pipe:1'],
            input=audio.astype('<f4').tobytes(), capture_output=True, check=True, timeout=30)
        stretched = np.frombuffer(transformed.stdout, dtype='<f4')
        ratio = len(stretched) / len(audio)
        for t in times:
            t['start'] *= ratio
            t['end'] *= ratio
        audio = stretched
    key = cache_key(body, doc)
    wav = CACHE / f'{key}.wav'
    sf.write(str(wav) + '.tmp', audio, 24000, format='WAV', subtype='PCM_16')
    Path(str(wav)+'.tmp').replace(wav)
    result = {'audio': f'/api/audio/{key}.wav', 'start': body.start, 'end': end, 'duration': len(audio)/24000,
              'backend': body.backend, 'timing': BACKENDS.definitions[body.backend]['timing'],
              'timings': [{'word': body.start+i, **t} for i,t in enumerate(times)]}
    temp = CACHE / f'{key}.json.tmp'
    temp.write_text(json.dumps(result))
    temp.replace(CACHE / f'{key}.json')
    return result


def cache_key(body, doc):
    # Bump the version whenever audio generation or timing behavior changes.
    content = ' '.join(doc['words'][body.start:choose_chunk(doc['words'], body.start)])
    # Preserve existing Kokoro cache keys; other engines have their own namespace.
    parts = ['v2', body.start, content, body.voice, body.speed]
    if body.backend != 'kokoro':
        parts = [body.backend, 'pocket-3.1.0-en202604-mac175-v1', *parts]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()


@app.post('/api/chunk')
async def chunk(body: Chunk, request: Request):
    if body.backend not in BACKENDS.definitions:
        raise HTTPException(422, 'Unknown speech engine')
    if body.voice not in BACKENDS.definitions[body.backend]['voices']:
        raise HTTPException(422, 'Unknown voice for this speech engine')
    doc = document(body.document)
    if not doc:
        raise HTTPException(404, 'Document not found')
    if body.start >= len(doc['words']):
        raise HTTPException(422, 'Word is outside the document')
    cached = CACHE / f'{cache_key(body, doc)}.json'
    if cached.exists():
        return {**json.loads(cached.read_text()), 'cached': True}
    if not BACKENDS.available(body.backend):
        raise HTTPException(503, BACKENDS.describe(body.backend)['error'])
    # Wait outside the speech executor so abandoned seek requests never build a queue.
    while True:
        if await request.is_disconnected():
            raise HTTPException(499, 'Playback request was cancelled')
        try:
            await asyncio.wait_for(GATE.acquire(), timeout=0.1)
            break
        except asyncio.TimeoutError:
            pass
    try:
        if await request.is_disconnected():
            raise HTTPException(499, 'Playback request was cancelled')
        if cached.exists():
            return {**json.loads(cached.read_text()), 'cached': True}
        started = time.perf_counter()
        result = await asyncio.get_running_loop().run_in_executor(POOL, generate, body, doc)
        return {**result, 'cached': False, 'generation_seconds': time.perf_counter()-started}
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(422, str(exc))
    finally:
        GATE.release()


@app.get('/api/images/{filename}')
def image_file(filename: str):
    if not re.fullmatch(r'[0-9a-f]{64}\.(png|jpg|jpeg|webp|gif)', filename):
        raise HTTPException(404)
    path = DATA / 'images' / filename
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, headers={'X-Content-Type-Options': 'nosniff',
                        'Cache-Control': 'private, max-age=31536000, immutable'})


@app.get('/api/audio/{filename}')
def audio_file(filename: str):
    if not re.fullmatch(r'[0-9a-f]{64}\.wav', filename) or not (CACHE/filename).exists():
        raise HTTPException(404)
    return FileResponse(CACHE/filename, media_type='audio/wav', headers={'Cache-Control':'private, max-age=31536000, immutable'})


app.mount('/', StaticFiles(directory=ROOT/'dist', html=True), name='web')
