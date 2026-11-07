import {describe,expect,test} from 'bun:test';
import {formatTimestamp,timestampAt,type TimelineChunk} from '../web/timeline';
const chunk=(start:number,end:number,duration:number):TimelineChunk=>({start,end,duration,
 timings:Array.from({length:end-start},(_,i)=>({word:start+i,start:i*duration/(end-start),end:(i+1)*duration/(end-start)}))});
describe('audio timestamps',()=>{
 test('beginning and contiguous chunks use actual durations',()=>{
  const chunks=[chunk(0,10,7),chunk(10,20,13)];
  expect(timestampAt(0,chunks,1)).toEqual({seconds:0,estimated:false});
  expect(timestampAt(10,chunks,1)).toEqual({seconds:7,estimated:false});
  expect(timestampAt(20,chunks,1)).toEqual({seconds:20,estimated:false});
  expect(timestampAt(15,chunks,1)).toEqual({seconds:13.5,estimated:false});
 });
 test('gaps estimate only missing words at current speed',()=>{
  const result=timestampAt(20,[chunk(0,5,3),chunk(10,20,8)],2);
  expect(result.estimated).toBe(true);
  expect(result.seconds).toBeCloseTo(11+5*60/165/2);
 });
 test('overlap is not counted twice and does not depend on input order',()=>{
  const a=chunk(0,10,10),b=chunk(5,15,20);
  expect(timestampAt(15,[a,b],1)).toEqual({seconds:20,estimated:false});
  expect(timestampAt(15,[b,a],1)).toEqual({seconds:20,estimated:false});
 });
 test('same start chooses longer coverage and nested intervals are skipped',()=>{
  expect(timestampAt(20,[chunk(0,10,99),chunk(0,20,20),chunk(3,5,99)],1))
   .toEqual({seconds:20,estimated:false});
 });
 test('partial missing timing is estimated, complete duration remains exact',()=>{
  const a={...chunk(0,10,8),timings:[]};
  expect(timestampAt(5,[a],1)).toEqual({seconds:4,estimated:true});
  expect(timestampAt(10,[a],1)).toEqual({seconds:8,estimated:false});
 });
 test('malformed persisted records and bad timing fail safely',()=>{
  const bad=[null,{}, {start:0,end:10,duration:NaN}, {start:4,end:2,duration:4},
   {...chunk(0,10,8),timings:[{word:5,start:-4,end:1}]}] as unknown as TimelineChunk[];
  expect(timestampAt(5,bad,1)).toEqual({seconds:4,estimated:true});
  expect(timestampAt(Infinity,bad,NaN)).toEqual({seconds:0,estimated:false});
 });
 test('approximate word timings mark partial and overlapping coverage only',()=>{
  const a={...chunk(0,10,10),approximateTimings:true};
  const b={...chunk(5,15,20),approximateTimings:true};
  expect(timestampAt(10,[a],1)).toEqual({seconds:10,estimated:false});
  expect(timestampAt(5,[a],1)).toEqual({seconds:5,estimated:true});
  expect(timestampAt(15,[a,b],1)).toEqual({seconds:20,estimated:true});
  expect(timestampAt(20,[a,{...chunk(10,20,10),approximateTimings:true}],1))
   .toEqual({seconds:20,estimated:false});
 });
 test('format timestamps includes hours and clamps invalid input',()=>{
  expect([0,9.9,65,3599,3600,3723,NaN,-4].map(formatTimestamp))
   .toEqual(['0:00','0:09','1:05','59:59','1:00:00','1:02:03','0:00','0:00']);
 });
});
