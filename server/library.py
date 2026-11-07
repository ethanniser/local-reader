import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from pathlib import Path
from bs4 import BeautifulSoup
from markdown_it import MarkdownIt
from .formatting import inline_text, normalize_marks, block_kind, FORMAT_VERSION

DATA = Path(os.environ.get('LOCAL_READER_DATA', Path.home() / 'Library/Application Support/Local Reader'))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / 'library.sqlite3'


def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    return db


def paragraphs(text, kind='txt'):
    if kind in ('md', 'markdown'):
        text = re.sub(r'\A---\s*\n.*?\n---\s*\n', '', text, count=1, flags=re.S)
        text = MarkdownIt().render(text)
        kind = 'html'
    if kind in ('html', 'htm'):
        soup = BeautifulSoup(text, 'html.parser')
        for node in soup(['script', 'style', 'nav', 'footer', 'header', 'noscript']):
            node.decompose()
        result = []
        for node in soup.select('h1,h2,h3,h4,h5,h6,p,li,blockquote,td,pre'):
            if node.find(['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
                continue
            value, marks = inline_text(node)
            if value:
                result.append({'text': value, 'kind': block_kind(node), **({'marks':marks} if marks else {})})
        if result:
            return result
        value, marks = inline_text(soup)
        return [{'text':value, 'kind':'paragraph', **({'marks':marks} if marks else {})}] if value else []
    return [{'text': re.sub(r'\s+', ' ', s).strip(), 'kind': 'paragraph'} for s in re.split(r'\n\s*\n', text) if s.strip()]


def normalize_tags(tags):
    if not isinstance(tags, list) or len(tags) > 20:
        raise ValueError('Use at most 20 tags.')
    result = []
    for tag in tags:
        if not isinstance(tag, str):
            raise ValueError('Tags must be text.')
        tag = re.sub(r'\s+', ' ', tag).strip().lower()
        if not tag or len(tag) > 60:
            raise ValueError('Each tag must contain 1 to 60 characters.')
        if tag not in result:
            result.append(tag)
    return result


def collection_tags(group):
    name = re.sub(r'\s+', ' ', group or '').strip().lower()
    if not name or name == 'your documents':
        return []
    return [name[:60]]


def list_documents():
    with connect() as db:
        rows = db.execute("SELECT id,title,collection,source,unread,words,position,updated,tags,metadata_updated,content_updated,read_updated,archived,deleted,lifecycle_updated,COALESCE(json_array_length(content,'$.images'),0) AS image_count FROM documents WHERE deleted=0 ORDER BY title COLLATE NOCASE,id").fetchall()
    return [{**dict(row), 'unread': bool(row['unread']), 'archived': bool(row['archived']), 'deleted': bool(row['deleted']), 'tags': json.loads(row['tags'])} for row in rows]


def update_tags(doc_id, tags):
    tags = normalize_tags(tags)
    with connect() as db:
        result = db.execute('UPDATE documents SET tags=?,metadata_updated=? WHERE id=? AND deleted=0', (json.dumps(tags, ensure_ascii=False), time.time(), doc_id))
        if not result.rowcount:
            return None
    return tags


def update_read_status(doc_id, unread):
    if type(unread) is not bool:
        raise ValueError('Unread must be a boolean.')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT read_updated FROM documents WHERE id=? AND deleted=0', (doc_id,)).fetchone()
        if row is None:
            return None
        timestamp = max(time.time(), row['read_updated'] + 0.000001)
        db.execute('UPDATE documents SET unread=?,read_updated=? WHERE id=?', (int(unread), timestamp, doc_id))
    return {'unread': unread, 'read_updated': timestamp}


def update_lifecycle(doc_id, *, archived=None, deleted=False):
    if archived is not None and type(archived) is not bool or type(deleted) is not bool:
        raise ValueError('Lifecycle choices must be booleans.')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT archived,deleted,lifecycle_updated FROM documents WHERE id=?', (doc_id,)).fetchone()
        if row is None or row['deleted'] and not deleted:
            return None
        if row['deleted']:
            return {'archived':bool(row['archived']), 'deleted':True, 'lifecycle_updated':row['lifecycle_updated']}
        archived = bool(row['archived']) if archived is None else archived
        timestamp = max(time.time(), row['lifecycle_updated'] + 0.000001)
        db.execute('UPDATE documents SET archived=?,deleted=?,lifecycle_updated=? WHERE id=?', (int(archived),int(deleted),timestamp,doc_id))
    return {'archived':archived, 'deleted':deleted, 'lifecycle_updated':timestamp}


def add_document(title, blocks, group='Your documents', source='', unread=True, doc_id=None, images=None, tags=None, marks=None):
    words = []
    clean = []
    extracted_marks = []
    for block in blocks:
        values = re.findall(r'\S+', block['text'])
        if not values:
            continue
        for mark in normalize_marks(block.get('marks', []), len(values)):
            extracted_marks.append({**mark, 'start':mark['start']+len(words), 'end':mark['end']+len(words)})
        clean.append({'start': len(words), 'end': len(words)+len(values), 'kind': block['kind']})
        words.extend(values)
    if not words:
        raise ValueError('No readable text found. Scanned PDFs need OCR before import.')
    if len(words) > 250000:
        raise ValueError('Please split documents larger than 250,000 words.')
    stored_marks = normalize_marks(extracted_marks if marks is None else marks, len(words))
    stored_images = [{**image, 'position': max(0, min(len(words), int(image.get('position', 0))))} for image in (images or [])]
    content = json.dumps({'words': words, 'paragraphs': clean, **({'images': stored_images} if stored_images else {}), **({'marks': stored_marks} if stored_marks else {})}, ensure_ascii=False)
    explicit_id = doc_id is not None
    doc_id = doc_id or hashlib.sha256((title+content).encode()).hexdigest()[:24]
    # Explicit [] distinguishes format-aware local content from an old client's
    # lossy cache. Keep the historical unformatted identity hash unchanged.
    content = json.dumps({**json.loads(content), 'marks': stored_marks, 'formatVersion': FORMAT_VERSION}, ensure_ascii=False)
    tags = normalize_tags(collection_tags(group) if tags is None else tags)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT deleted FROM documents WHERE id=?', (doc_id,)).fetchone()
        if existing and existing['deleted'] and not explicit_id:
            # Explicit re-import is a new article; never resurrect a synced tombstone.
            doc_id = uuid.uuid4().hex[:24]
        db.execute('INSERT OR IGNORE INTO documents(id,title,collection,source,unread,content,words,tags,metadata_updated,content_updated,read_updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   (doc_id, title, group, source, int(unread), content, len(words), json.dumps(tags, ensure_ascii=False), time.time(), time.time(), time.time()))
    return doc_id


def initialize():
    with connect() as db:
        # Make adding the column and migrating its data one atomic operation.
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT,collection TEXT,source TEXT,unread INTEGER,content TEXT,words INTEGER,position INTEGER DEFAULT 0,updated REAL DEFAULT 0)')
        columns = {row['name'] for row in db.execute('PRAGMA table_info(documents)')}
        if 'tags' not in columns:
            db.execute("ALTER TABLE documents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
            for row in db.execute('SELECT id,collection FROM documents').fetchall():
                # Legacy collections become ordinary tags.
                tags = collection_tags(row['collection'])
                db.execute('UPDATE documents SET tags=? WHERE id=?', (json.dumps(tags, ensure_ascii=False), row['id']))
        for name in ('metadata_updated', 'content_updated'):
            if name not in columns:
                db.execute(f'ALTER TABLE documents ADD COLUMN {name} REAL NOT NULL DEFAULT 0')
        if 'read_updated' not in columns:
            db.execute('ALTER TABLE documents ADD COLUMN read_updated REAL NOT NULL DEFAULT 0')
            # Legacy read state beats an absent cloud default (0), but must not
            # override a real manual cloud choice made before this Mac upgrades.
            db.execute('UPDATE documents SET read_updated=1 WHERE unread=0')
        for name in ('archived', 'deleted'):
            if name not in columns:
                db.execute(f'ALTER TABLE documents ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0')
        if 'lifecycle_updated' not in columns:
            db.execute('ALTER TABLE documents ADD COLUMN lifecycle_updated REAL NOT NULL DEFAULT 0')


def document(doc_id):
    with connect() as db:
        row = db.execute('SELECT * FROM documents WHERE id=? AND deleted=0', (doc_id,)).fetchone()
    if not row:
        return None
    result = dict(row)
    result['unread'] = bool(result['unread'])
    result['archived'] = bool(result['archived'])
    result['deleted'] = bool(result['deleted'])
    result['tags'] = json.loads(result['tags'])
    result.update(json.loads(result.pop('content')))
    result.setdefault('marks', [])
    return result


def choose_chunk(words, start):
    # About 8–16 seconds. Prefer sentence/paragraph punctuation to preserve prosody.
    end = min(start + 36, len(words))
    length = 0
    for i in range(start, end):
        length += len(words[i]) + 1
        if length > 300 and i > start:
            end = i
            break
        if i >= start + 15 and re.search(r'[.!?][”\'"’)]*$', words[i]):
            end = i + 1
            break
    return end
