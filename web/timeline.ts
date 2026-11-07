/** Audio durations are authoritative; ungenerated passages stay explicitly estimated. */
export type TimelineChunk = {
 start:number; end:number; duration:number; approximateTimings?:boolean;
 timings:{word:number;start:number;end:number}[];
};
export type Timestamp = {seconds:number;estimated:boolean};

function validChunk(value:unknown):value is TimelineChunk {
 if(!value||typeof value!=='object')return false;
 const chunk=value as TimelineChunk;
 return Number.isInteger(chunk.start)&&chunk.start>=0&&Number.isInteger(chunk.end)&&
  chunk.end>chunk.start&&Number.isFinite(chunk.duration)&&chunk.duration>0;
}

function offsetAt(chunk:TimelineChunk,word:number):Timestamp {
 if(word<=chunk.start)return {seconds:0,estimated:false};
 if(word>=chunk.end)return {seconds:chunk.duration,estimated:false};
 const timings=Array.isArray(chunk.timings)?chunk.timings:[];
 const timing=timings.find(t=>t&&t.word===word&&Number.isFinite(t.start)&&
  Number.isFinite(t.end)&&t.start>=0&&t.end>=t.start&&t.end<=chunk.duration);
 if(timing)return {seconds:timing.start,estimated:chunk.approximateTimings===true};
 return {seconds:chunk.duration*(word-chunk.start)/(chunk.end-chunk.start),estimated:true};
}

export function timestampAt(word:number,chunks:readonly TimelineChunk[],speed:number):Timestamp {
 const target=Number.isFinite(word)?Math.max(0,Math.floor(word)):0;
 const secondsPerWord=60/165/(Number.isFinite(speed)&&speed>0?speed:1);
 // Earlier intervals win overlaps. Same-start intervals prefer fuller coverage.
 const ordered=(Array.isArray(chunks)?chunks:[]).filter(validChunk)
  .sort((a,b)=>a.start-b.start||b.end-a.end||a.duration-b.duration);
 let cursor=0,seconds=0,estimated=false;
 for(const chunk of ordered){
  if(cursor>=target)break;
  if(chunk.end<=cursor)continue;
  if(chunk.start>cursor){
   const end=Math.min(target,chunk.start);
   seconds+=(end-cursor)*secondsPerWord;cursor=end;estimated=true;
  }
  if(cursor>=target)break;
  const end=Math.min(target,chunk.end);
  const from=offsetAt(chunk,cursor),to=offsetAt(chunk,end);
  // Corrupted/non-monotonic word timing must never move the timestamp backward.
  if(to.seconds<from.seconds){
   seconds+=(end-cursor)*chunk.duration/(chunk.end-chunk.start);estimated=true;
  }else{
   seconds+=to.seconds-from.seconds;estimated ||= from.estimated||to.estimated;
  }
  cursor=end;
 }
 if(cursor<target){seconds+=(target-cursor)*secondsPerWord;estimated=true;}
 return {seconds,estimated};
}

export function formatTimestamp(seconds:number):string {
 const whole=Number.isFinite(seconds)?Math.max(0,Math.floor(seconds)):0;
 const hours=Math.floor(whole/3600),minutes=Math.floor(whole/60)%60;
 const suffix=String(whole%60).padStart(2,'0');
 return hours?`${hours}:${String(minutes).padStart(2,'0')}:${suffix}`:`${minutes}:${suffix}`;
}
