// Uses an isolated Chrome profile and only a local fixture; no library uploads.
// PLAYWRIGHT_MODULE may point to a temporary playwright installation.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
require('./cloud-core.js');const cloud=globalThis.ReaderCloud;
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://newsletter.example.test/**',route=>route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/substack-like.html'),'utf8')}));
  await page.goto('https://newsletter.example.test/story');
  await page.addScriptTag({path:path.join(__dirname,'extract-article.js')});
  const result=await page.evaluate(()=>extractArticleContent(document.querySelector('article')));
  const blocks=result.paragraphs.map(p=>({kind:p.kind,text:result.words.slice(p.start,p.end).join(' ')}));
  assert.equal(blocks.find(p=>p.text==='First section').kind,'heading');
  assert.equal(blocks.find(p=>p.text==='Another section').kind,'heading');
  assert.equal(blocks.find(p=>p.text==='Quoted thought one.').kind,'blockquote');
  assert.equal(blocks.find(p=>p.text==='Second quoted paragraph.').kind,'blockquote');
  assert.equal(blocks.find(p=>p.text==='A final paragraph.').kind,'paragraph');
  assert(!result.text.includes('Never import'));assert(!result.text.includes('Unrelated navigation'));
  assert(result.words.includes('interoperable'));assert(!result.words.includes('oper'));
  const marked=result.marks.map(mark=>({...mark,text:result.words.slice(mark.start,mark.end).join(' ')}));
  for(const [kind,text]of [['bold','bold phrase,'],['italic','italic phrase,'],['underline','underlined words.'],['bold','bold'],['italic','italic'],['underline','underlined'],['bold','interoperable']])assert(marked.some(mark=>mark.kind===kind&&mark.text===text),`${kind}: ${text}`);
  assert(marked.some(mark=>mark.kind==='link'&&mark.href==='https://newsletter.example.test/reference'&&mark.text==='a useful link.'));
  const saved=cloud.article({id:'substack-fixture',payload:{...result,source:'https://newsletter.example.test/story'}},'Fixture',result.text,'essays');
  assert.deepEqual(saved.paragraphs,result.paragraphs);assert.deepEqual(saved.marks,result.marks);
  const selection=await page.evaluate(()=>{const paragraph=document.querySelector('blockquote p'),range=document.createRange();range.selectNodeContents(paragraph);return extractArticleContent(paragraph,range);});
  assert.equal(selection.paragraphs[0].kind,'blockquote');assert.equal(selection.text,'Quoted thought one.');
  const background=fs.readFileSync(path.join(__dirname,'background.js'),'utf8'),popup=fs.readFileSync(path.join(__dirname,'popup.js'),'utf8');
  assert(!background.includes('review-page'));assert(!popup.includes('review-page'));assert(!background.includes("getURL('preview.html')"));
  console.log('Substack-like headings, nested quotes, inline/CSS marks, selection and one-click-only route pass.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
