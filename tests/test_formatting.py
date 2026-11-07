import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup
_tmp=tempfile.TemporaryDirectory(prefix='reader-format-import-')
os.environ.setdefault('LOCAL_READER_DATA',_tmp.name)
from server import library
from server.formatting import inline_text, normalize_marks, blocks_from_ranges
from server.article_import import extract_html


class FormattingTests(unittest.TestCase):
    def setUp(self):
        self.temp=self.enterContext(tempfile.TemporaryDirectory())
        self.root=Path(self.temp)
        self.enterContext(patch.object(library,'DB',self.root/'library.sqlite3'))
        library.initialize()

    def test_semantics_preserve_inline_word_adjacency(self):
        node=BeautifulSoup('<p><strong>Hel</strong>lo <em>beautiful <u>world</u></em>! <a href="/story">Read more</a>.</p>','html.parser').p
        text,marks=inline_text(node,'https://example.org/page')
        self.assertEqual(text,'Hello beautiful world! Read more.')
        self.assertIn({'start':0,'end':1,'kind':'bold'},marks)
        self.assertIn({'start':1,'end':3,'kind':'italic'},marks)
        self.assertIn({'start':2,'end':3,'kind':'underline'},marks)
        self.assertIn({'start':3,'end':5,'kind':'link','href':'https://example.org/story'},marks)

    def test_div_article_fallback_separates_blocks_but_not_inline_words(self):
        html='<article><div>Hello <b>wor</b>ld</div><div>Next paragraph '+('more words '*12)+'</div></article>'
        article=extract_html(html,'https://example.org/story')
        self.assertTrue(article['blocks'][0]['text'].startswith('Hello world Next paragraph '))
        self.assertIn({'start':1,'end':2,'kind':'bold'},article['blocks'][0]['marks'])
        blocks=library.paragraphs('<div>Hello <span>wor</span>ld</div><div>Next paragraph</div>','html')
        self.assertEqual(blocks[0]['text'],'Hello world Next paragraph')

    def test_html_markdown_and_old_docs(self):
        for kind,text in [('html','<h1>Title</h1><p>A <strong>bold</strong> and <em>italic</em> word.</p>'),
                          ('md','# Title\n\nA **bold** and *italic* word.')]:
            id=library.add_document(kind,library.paragraphs(text,kind))
            doc=library.document(id)
            self.assertEqual(doc['words'],['Title','A','bold','and','italic','word.'])
            self.assertEqual(doc['marks'],[{'start':2,'end':3,'kind':'bold'},{'start':4,'end':5,'kind':'italic'}])
        old=library.add_document('Plain',library.paragraphs('plain words'))
        self.assertEqual(library.document(old)['marks'],[])

    def test_url_article_keeps_marks_and_ignores_unsafe_links(self):
        html='<article><p><b>Hello</b> <a href="javascript:alert(1)">unsafe</a> '+('more words '*20)+'</p></article>'
        result=extract_html(html,'https://example.org')
        id=library.add_document(result['title'],result['blocks'],source=result['source'])
        self.assertEqual(library.document(id)['marks'],[{'start':0,'end':1,'kind':'bold'}])
        self.assertNotIn('alert', ' '.join(library.document(id)['words']))

    def test_substack_nested_quotes_keep_heading_and_inline_marks(self):
        html='<article><h2>Section heading</h2><blockquote><p>A <strong>bold quotation</strong>.</p><p>Another <em>quoted paragraph</em> with <a href="https://example.org/read">a link</a>.</p><blockquote><p>Nested quote.</p></blockquote></blockquote><p>'+('Normal prose words '*10)+'</p></article>'
        for blocks in [library.paragraphs(html,'html'), extract_html(html,'https://example.org/story')['blocks']]:
            self.assertEqual([b['kind'] for b in blocks],['heading','blockquote','blockquote','blockquote','paragraph'])
            doc_id=library.add_document('Quotes',blocks)
            doc=library.document(doc_id)
            self.assertEqual(doc['formatVersion'],2)
            self.assertEqual(doc['words'].count('Nested'),1)
            self.assertEqual({m['kind'] for m in doc['marks']},{'bold','italic','link'})
            self.assertEqual(doc['paragraphs'][1]['kind'],'blockquote')
        blocks=library.paragraphs('## Heading\n\n> A **bold** quote.\n>\n> Another *italic* paragraph.\n\nNormal prose.','md')
        self.assertEqual([b['kind'] for b in blocks],['heading','blockquote','blockquote','paragraph'])
        self.assertEqual(blocks[1]['marks'],[{'start':1,'end':2,'kind':'bold'}])
        # A quote containing only a heading must not import that heading twice.
        self.assertEqual(library.paragraphs('<blockquote><h2>Quoted heading</h2></blockquote>','html'),[{'text':'Quoted heading','kind':'heading'}])

    def test_malicious_marks_and_ranges_rejected(self):
        invalid=[{'start':True,'end':1,'kind':'bold'},{'start':0,'end':4,'kind':'bold'},
                 {'start':0,'end':0,'kind':'bold'},{'start':0,'end':1,'kind':[]},
                 {'start':0,'end':1,'kind':'script'}, {'start':0,'end':1,'kind':'link','href':'javascript:alert(1)'},
                 {'start':0,'end':1,'kind':'link','href':'https://user:password@example.org'},
                 {'start':0,'end':1,'kind':'link','href':'file:///secret'}]
        for mark in invalid:
            with self.assertRaises(ValueError,msg=mark):normalize_marks([mark],3)
        with self.assertRaises(ValueError):normalize_marks([{'start':0,'end':1,'kind':'bold'}]*50001,3)
        with self.assertRaises(ValueError):blocks_from_ranges('one two three',[{'start':1,'end':3,'kind':'paragraph'}])

    def test_paste_structured_marks_preserve_positions_and_heading(self):
        from fastapi.testclient import TestClient
        from server.app import app
        client=TestClient(app)
        body={'title':'Structured','text':'A heading\n\nSome bold text.',
              'paragraphs':[{'start':0,'end':2,'kind':'heading'},{'start':2,'end':5,'kind':'blockquote'}],
              'marks':[{'start':3,'end':4,'kind':'bold'}]}
        result=client.post('/api/import/text',json=body)
        self.assertEqual(result.status_code,200,result.text)
        doc=library.document(result.json()['id'])
        self.assertEqual(doc['paragraphs'],body['paragraphs'])
        self.assertEqual(doc['marks'],body['marks'])
        before={key:doc[key] for key in ('position','updated','read_updated','metadata_updated','content_updated')}
        library.update_read_status(doc['id'],False)
        library.update_tags(doc['id'],['tag'])
        self.assertEqual(library.document(doc['id'])['marks'],body['marks'])
        body['marks']=[{'start':0,'end':99,'kind':'bold'}]
        self.assertEqual(client.post('/api/import/text',json=body).status_code,422)


if __name__=='__main__':unittest.main()
