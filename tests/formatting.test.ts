import {test,expect} from 'bun:test';
import {formattedWords,wordRun} from '../web/formatting';
test('nested emphasis and a phrase link keep stable spoken word IDs',()=>{
 const words=formattedWords(['A','bold','linked','phrase','ends'],[{start:1,end:4,kind:'bold'},{start:2,end:4,kind:'italic'},{start:2,end:4,kind:'link',href:'https://example.com/?a=1&b=2'}]);
 const html=wordRun(words,0,5);
 expect(html.match(/<a /g)?.length).toBe(1);expect(html.match(/data-word=/g)?.length).toBe(5);
 expect(html).toContain('word fmt-bold fmt-italic');expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
 expect(wordRun(words,3,5)).toContain('id="w-3"');
});
test('untrusted text and unsafe links cannot become executable HTML',()=>{
 const words=formattedWords(['<img onerror=alert(1)>','safe'],[{start:0,end:2,kind:'link',href:'javascript:alert(1)'},{start:0,end:1,kind:'bold'},{start:0,end:9,kind:'underline'},{start:1,end:2,kind:'link',href:'https://user:pass@example.com'}]);
 const html=wordRun(words,0,2);expect(html).not.toContain('<a ');expect(html).not.toContain('<img');expect(html).toContain('&lt;img');expect(html).not.toContain('fmt-underline');
});
