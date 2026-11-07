"""Safe semantic formatting indexed by the reader's whitespace-delimited words."""
from bisect import bisect_left, bisect_right
import re
from urllib.parse import urljoin, urlsplit

from bs4 import Comment, NavigableString, Tag

KINDS = {'bold', 'italic', 'underline', 'link'}
MAX_MARKS = 50000
BLOCK_NAMES = {'address','article','aside','blockquote','dd','details','dialog','div','dl','dt',
               'fieldset','figcaption','figure','footer','form','h1','h2','h3','h4','h5','h6',
               'header','hgroup','hr','li','main','nav','ol','p','pre','section','table',
               'tbody','thead','tfoot','tr','td','th','ul'}


PARAGRAPH_KINDS = {'heading', 'paragraph', 'blockquote'}
FORMAT_VERSION = 2


def block_kind(node):
    """Classify leaf blocks without losing quote ancestry around nested <p>s."""
    if node.name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
        return 'heading'
    if node.name == 'blockquote' or node.find_parent('blockquote') is not None:
        return 'blockquote'
    return 'paragraph'


def safe_href(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 4096 or any(ord(c) < 32 for c in value):
        raise ValueError('Formatting links must be public HTTP or HTTPS URLs without credentials.')
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or '@' in parsed.netloc:
            raise ValueError
        parsed.port
    except ValueError:
        raise ValueError('Formatting links must be HTTP or HTTPS URLs without credentials.') from None
    return value


def normalize_marks(marks, word_count):
    if not isinstance(marks, list) or len(marks) > MAX_MARKS:
        raise ValueError('Use at most 50,000 formatting marks.')
    result = []
    for mark in marks:
        if (not isinstance(mark, dict) or type(mark.get('start')) is not int or type(mark.get('end')) is not int
                or not 0 <= mark['start'] < mark['end'] <= word_count or not isinstance(mark.get('kind'), str) or mark['kind'] not in KINDS):
            raise ValueError('Formatting ranges must refer to valid article words.')
        clean = {'start': mark['start'], 'end': mark['end'], 'kind': mark['kind']}
        if mark['kind'] == 'link':
            clean['href'] = safe_href(mark.get('href'))
        result.append(clean)
    return result


def inline_text(node, source=''):
    """Retain text-node adjacency; <b>mid</b>-word styling must not split words."""
    parts, spans = [], []
    length = 0
    def append(text):
        nonlocal length
        parts.append(text)
        length += len(text)
    def visit(current):
        if isinstance(current, Comment):
            return
        if isinstance(current, NavigableString):
            append(str(current))
            return
        if not isinstance(current, Tag) or current.name in ('script','style','noscript','iframe','svg'):
            return
        if current.has_attr('hidden') or current.get('aria-hidden') == 'true':
            return
        if current.name == 'br':
            append('\n')
            return
        is_block = current.name in BLOCK_NAMES
        if is_block:
            append('\n')
        start = length
        for child in current.children:
            visit(child)
        if is_block:
            append('\n')
        kind = {'strong':'bold','b':'bold','em':'italic','i':'italic','u':'underline','a':'link'}.get(current.name)
        if not kind or start == length:
            return
        mark = {'kind':kind}
        if kind == 'link':
            if not current.get('href'):
                return
            try:
                mark['href'] = safe_href(urljoin(source, current.get('href', '')))
            except (TypeError, ValueError):
                return
        spans.append((start, length, mark))
    visit(node)
    raw = ''.join(parts)
    tokens = list(re.finditer(r'\S+', raw))
    starts = [m.start() for m in tokens]
    ends = [m.end() for m in tokens]
    marks = []
    for start, end, mark in spans:
        first = bisect_right(ends, start)
        last = bisect_left(starts, end)
        if first < last:
            marks.append({'start':first,'end':last,**mark})
    return ' '.join(m.group() for m in tokens), normalize_marks(marks, len(tokens))


def blocks_from_ranges(text, ranges):
    words = re.findall(r'\S+', text)
    if not isinstance(ranges, list) or not ranges or len(ranges) > 250000:
        raise ValueError('Paragraph ranges must cover the article words.')
    blocks, cursor = [], 0
    for paragraph in ranges:
        if (not isinstance(paragraph, dict) or type(paragraph.get('start')) is not int or type(paragraph.get('end')) is not int
                or paragraph['start'] != cursor or not cursor < paragraph['end'] <= len(words)
                or not isinstance(paragraph.get('kind'), str) or paragraph['kind'] not in PARAGRAPH_KINDS):
            raise ValueError('Paragraph ranges must cover the article words in order.')
        blocks.append({'text':' '.join(words[cursor:paragraph['end']]),'kind':paragraph['kind']})
        cursor = paragraph['end']
    if cursor != len(words):
        raise ValueError('Paragraph ranges must cover every article word.')
    return blocks
