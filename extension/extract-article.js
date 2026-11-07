/* Shared with Safari preprocessing: visible DOM -> plain words plus safe word marks. */
function extractArticleContent(root, selectionRange=null) {
  const parts=[],charMarks=[],headings=[],quotes=[];let length=0;
  const append=text=>{parts.push(text);length+=text.length;};
  const visible=node=>{const style=getComputedStyle(node);return style.visibility!=='hidden'&&style.display!=='none'&&(node.getClientRects().length>0||style.display==='contents');};
  const safeLink=value=>{if(typeof value!=='string'||!value.trim())return null;try{const url=new URL(value,location.href);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.href.length<=4096?url.href:null;}catch{return null;}};
  function visit(node){
    if(selectionRange&&!selectionRange.intersectsNode(node))return;
    if(node.nodeType===Node.TEXT_NODE){
      let value=node.nodeValue||'';
      const start=selectionRange?.startContainer===node?selectionRange.startOffset:0;
      const end=selectionRange?.endContainer===node?selectionRange.endOffset:value.length;
      append(value.slice(start,end));return;
    }
    if(node.nodeType!==Node.ELEMENT_NODE||!visible(node)||['SCRIPT','STYLE','NOSCRIPT','IFRAME','SVG','CANVAS'].includes(node.tagName))return;
    const style=getComputedStyle(node),block=/^(block|list-item|table-row|flex|grid|flow-root)/.test(style.display)||/^H[1-6]$/.test(node.tagName);
    if(node.tagName==='BR'){append('\n');return;}
    if(block)append('\n\n');
    const start=length;
    for(const child of node.childNodes)visit(child);
    const end=length;
    if(end>start){
      if(/^H[1-6]$/.test(node.tagName))headings.push({start,end});
      if(node.tagName==='BLOCKQUOTE')quotes.push({start,end});
      if(['B','STRONG'].includes(node.tagName)||Number.parseInt(style.fontWeight,10)>=600)charMarks.push({start,end,kind:'bold'});
      if(['I','EM'].includes(node.tagName)||style.fontStyle==='italic'||style.fontStyle.startsWith('oblique'))charMarks.push({start,end,kind:'italic'});
      if(node.tagName==='U'||style.textDecorationLine.includes('underline'))charMarks.push({start,end,kind:'underline'});
      if(node.tagName==='A'){const href=safeLink(node.getAttribute('href'));if(href)charMarks.push({start,end,kind:'link',href});}
    }
    if(block)append('\n\n');
  }
  visit(root);
  // A selected passage can start inside a quote or heading rather than at its outer tag.
  if(root.closest?.('blockquote'))quotes.push({start:0,end:length});
  if(root.closest?.('h1,h2,h3,h4,h5,h6'))headings.push({start:0,end:length});
  const raw=parts.join(''),matches=[...raw.matchAll(/\S+/g)],words=matches.map(match=>match[0]);
  const paragraphs=[];let start=0;
  for(let i=1;i<=matches.length;i++){
    if(i===matches.length||/\n\s*\n/.test(raw.slice(matches[i-1].index+matches[i-1][0].length,matches[i]?.index))){
      if(i>start){const left=matches[start].index,right=matches[i-1].index+matches[i-1][0].length;
       paragraphs.push({start,end:i,kind:headings.some(h=>left>=h.start&&right<=h.end)?'heading':quotes.some(q=>left>=q.start&&right<=q.end)?'blockquote':'paragraph'});start=i;}
    }
  }
  // Overlapping ranges style complete words, never create extra words at inline boundaries.
  const firstAtOrAfter=value=>{let lo=0,hi=matches.length;while(lo<hi){const mid=(lo+hi)>>1;if(matches[mid].index+matches[mid][0].length<=value)lo=mid+1;else hi=mid;}return lo;};
  const endBefore=value=>{let lo=0,hi=matches.length;while(lo<hi){const mid=(lo+hi)>>1;if(matches[mid].index<value)lo=mid+1;else hi=mid;}return lo;};
  const seen=new Set(),marks=[];
  for(const mark of charMarks){const start=firstAtOrAfter(mark.start),end=endBefore(mark.end);if(end<=start)continue;const item={start,end,kind:mark.kind,...(mark.href?{href:mark.href}:{})};const key=JSON.stringify(item);if(!seen.has(key)){seen.add(key);marks.push(item);}if(marks.length>=50000)break;}
  const text=paragraphs.map(p=>words.slice(p.start,p.end).join(' ')).join('\n\n');
  return{text,words,paragraphs,marks};
}
globalThis.extractArticleContent=extractArticleContent;
