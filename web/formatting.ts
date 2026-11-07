export type ArticleMark={start:number;end:number;kind:'bold'|'italic'|'underline'|'link';href?:string};
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function safeLink(value:unknown):string|null{
 if(typeof value!=='string'||value.length>4096)return null;
 try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function formattedWords(words:string[],input:ArticleMark[]=[]):{html:string;href:string|null}[]{
 const starts=new Map<number,number[]>(),ends=new Map<number,number[]>();
 const marks=(Array.isArray(input)?input:[]).slice(0,50000).filter(mark=>mark&&Number.isInteger(mark.start)&&Number.isInteger(mark.end)&&mark.start>=0&&mark.end>mark.start&&mark.end<=words.length&&['bold','italic','underline','link'].includes(mark.kind));
 const links=marks.map(mark=>mark.kind==='link'?safeLink(mark.href):null);
 marks.forEach((mark,id)=>{if(!starts.has(mark.start))starts.set(mark.start,[]);if(!ends.has(mark.end))ends.set(mark.end,[]);starts.get(mark.start)!.push(id);ends.get(mark.end)!.push(id);});
 const activeLinks=new Map<number,string>(),counts={bold:0,italic:0,underline:0};
 const apply=(id:number,adding:boolean)=>{const mark=marks[id];if(mark.kind==='link'){if(adding&&links[id])activeLinks.set(id,links[id]!);else activeLinks.delete(id);}else counts[mark.kind]+=adding?1:-1;};
 return words.map((word,index)=>{
  for(const id of ends.get(index)||[])apply(id,false);
  for(const id of starts.get(index)||[])apply(id,true);
  const styles=(['bold','italic','underline'] as const).filter(kind=>counts[kind]>0).map(kind=>' fmt-'+kind).join('');
  return{html:`<span class="word${styles}" id="w-${index}" data-word="${index}">${escape(word)}</span>`,href:activeLinks.values().next().value??null};
 });
}
export function wordRun(words:ReturnType<typeof formattedWords>,start:number,end:number):string{
 let html='',href:string|null=null;
 for(let index=start;index<end;index++){
  const word=words[index];if(!word)continue;
  if(word.href!==href){if(href)html+='</a>';if(index>start)html+=' ';href=word.href;if(href)html+=`<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">`;}
  else if(index>start)html+=' ';
  html+=word.html;
 }
 return html+(href?'</a>':'');
}
