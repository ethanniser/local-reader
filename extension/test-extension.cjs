const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/background.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync(__dirname + '/manifest.json', 'utf8'));
assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'offscreen']);
assert.deepEqual(manifest.host_permissions, ['https://*.convex.site/*']);
function capture({selection = '', protocol = 'https:', candidates = [], body = 'Body text', url = 'https://example.com/article'} = {}) {
  const context = vm.createContext({URL, importScripts(){},
    chrome: {runtime: {onMessage: {addListener() {}}}},
    location: {protocol, href: url},
    window: {getSelection: () => ({toString: () => selection})},
    document: {title: 'Article title', querySelectorAll: () => candidates, body: {innerText: body, querySelectorAll: () => []}},
    getComputedStyle: element => ({visibility: element.hidden ? 'hidden' : 'visible'})
  });
  vm.runInContext(source, context);
  return vm.runInContext('capturePage()', context);
}
function article(text, links = '', hidden = false) {
  return {innerText: text, hidden, getClientRects: () => [1], querySelectorAll: selector => selector === 'a' ? [{innerText: links}] : []};
}
assert.equal(capture({selection: '  Selected passage  '}).text, 'Selected passage');
assert.equal(capture({candidates: [article('Hidden text'.repeat(100), '', true), article('Visible article')]}).text, 'Visible article');
assert.equal(capture({candidates: [article('Navigation'.repeat(20), 'Navigation'.repeat(20)), article('The actual article text')]}).text, 'The actual article text');
assert.equal(capture().source, 'https://example.com/article');
assert.match(capture({protocol: 'chrome:'}).error, /website first/);
assert.match(capture({body: ''}).error, /No readable text/);
assert.match(capture({selection: 'x'.repeat(2000001)}).error, /too large/);
assert.match(capture({url: 'https://name:password@example.com/article'}).error, /credentials/);
assert.match(capture({url: 'https://example.com/' + 'x'.repeat(4096)}).error, /long URL/);
const image = (overrides = {}) => ({getClientRects: () => [1], complete: true,
  naturalWidth: 600, naturalHeight: 400, currentSrc: 'https://example.com/photo.jpg', alt: 'Photo',
  closest: () => null, parentElement: null, previousSibling: null, ...overrides});
const imageArticle = article('First paragraph. Last paragraph.');
const photo = image({parentElement: imageArticle, previousSibling: {nodeType: 1, innerText: 'First paragraph.', getClientRects: () => [1], previousSibling: null}});
imageArticle.querySelectorAll = selector => selector === 'img' ? [photo] : [];
const capturedImage = capture({candidates: [imageArticle]});
assert.equal(capturedImage.images.length, 1);
assert.equal(capturedImage.images[0].position, 2);
assert.equal(capturedImage.images[0].src, 'https://example.com/photo.jpg');
assert.equal(capture({selection: 'Selected', candidates: [imageArticle]}).images.length, 0);
for (const invalid of [{hidden: true}, {naturalWidth: 1, naturalHeight: 1}, {currentSrc: 'javascript:alert(1)'}, {currentSrc:'https://user:pass@example.com/image.jpg'}]) {
  imageArticle.querySelectorAll = selector => selector === 'img' ? [image(invalid)] : [];
  assert.equal(capture({candidates: [imageArticle]}).images.length, 0);
}
const lazy = image({complete:false, naturalWidth:0, naturalHeight:0, getBoundingClientRect:()=>({width:640,height:360})});
imageArticle.querySelectorAll = selector => selector === 'img' ? [lazy] : [];
assert.equal(capture({candidates:[imageArticle]}).images[0].src, 'https://example.com/photo.jpg');
lazy.currentSrc='';lazy.src='';lazy.getAttribute=name=>name==='data-src'?'/lazy.jpg':null;
assert.equal(capture({candidates:[imageArticle]}).images[0].src,'https://example.com/lazy.jpg');
lazy.getBoundingClientRect=()=>({width:16,height:16});
assert.equal(capture({candidates:[imageArticle]}).images.length,0);
const caption = {innerText:'A useful caption.',getClientRects:()=>[1]};
photo.closest=()=>({querySelector:()=>caption});
imageArticle.querySelectorAll=selector=>selector==='img'?[photo]:[];
imageArticle.innerText='First paragraph. A useful caption. Last paragraph.';
assert.equal(capture({candidates:[imageArticle]}).images[0].caption,'');
imageArticle.innerText='First paragraph. Last paragraph.';
assert.equal(capture({candidates:[imageArticle]}).images[0].caption,'A useful caption.');
imageArticle.querySelectorAll = selector => selector === 'img' ? Array.from({length:30}, () => photo) : [];
assert.equal(capture({candidates: [imageArticle]}).images.length, 20);
console.log('Extension capture and permission checks passed.');
