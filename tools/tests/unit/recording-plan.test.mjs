import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecordingPlan} from '../../../src/media/recording-plan.js';
import {selectPlaylistRange} from '../../../src/media/playlist.js';

const manifest='#EXTM3U\n#EXTINF:3,\na.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nb.m4s';
const streams=[{stream:'https://example.com/first/list',start_time:100,end_time:108},{stream:'https://example.com/second/list',start_time:120,end_time:128}];
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('预估与两种下载共享清单，断流和不同服务端录像段保留绝对时间',async()=>{
  const seen=[];
  const api={async request(url){seen.push(url);return {data:manifest,url};}};
  const plan=new RecordingPlan(api,streams);
  const [estimate,selection,full]=await Promise.all([plan.load(),plan.load(),plan.load()]);
  assert.equal(estimate,selection);assert.equal(selection,full);
  assert.deepEqual(seen,streams.map(s=>s.stream));
  assert.deepEqual(full.map(g=>g.start),[100,103,120,123]);
  const parsed={groups:full.map(group=>({...group,offset:group.start-100}))};
  for(const [start,end,expected] of [[2,5,[[2,3],[3,5]]],[6,22,[[6,8],[20,22]]]]){
    assert.deepEqual(selectPlaylistRange(parsed,start,end).map(p=>[p.offset+p.start,p.offset+p.end]),expected);
  }
  assert.equal(await plan.load(),full);assert.equal(seen.length,2);
  await new RecordingPlan(api,streams).load();assert.equal(seen.length,4,'刷新建立新的清单，不复用旧签名');
});

test('取消下载只结束该调用者等待，预估仍能完成且共享请求不被取消',async()=>{
  const wait=deferred(),lifetime=new AbortController(),download=new AbortController();let calls=0;
  const plan=new RecordingPlan({async request(url,{signal}){calls++;assert.equal(signal,lifetime.signal);await wait.promise;return {data:manifest,url};}},streams.slice(0,1),lifetime.signal);
  const estimate=plan.load(),exportWait=plan.load(download.signal);
  download.abort();await assert.rejects(exportWait,{name:'AbortError'});
  assert.equal(lifetime.signal.aborted,false);
  wait.resolve();const groups=await estimate;
  assert.equal(groups.length,2);assert.equal(await plan.load(),groups);assert.equal(calls,1);
});

test('离开场次取消共享请求，迟到结果不能进入缓存；新场次独立加载',async()=>{
  const wait=deferred(),lifetime=new AbortController();let seenSignal;
  const api={async request(url,{signal}){seenSignal=signal;await wait.promise;return {data:manifest,url};}};
  const plan=new RecordingPlan(api,streams.slice(0,1),lifetime.signal),pending=plan.load();
  lifetime.abort();assert.equal(seenSignal.aborted,true);
  wait.resolve();await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(plan.load(),{name:'AbortError'});
  assert.equal((await new RecordingPlan(api,streams.slice(1)).load())[0].start,120);
});

test('网络失败或清单解析失败不缓存，下次操作可以重试',async()=>{
  for(const failure of ['network','parse']){
    let calls=0;
    const plan=new RecordingPlan({async request(url){calls++;if(calls===1){if(failure==='network')throw new Error('断网');return {data:'not HLS',url};}return {data:manifest,url};}},streams.slice(0,1));
    const results=await Promise.allSettled([plan.load(),plan.load()]);
    assert.ok(results.every(r=>r.status==='rejected'));assert.equal(calls,1);
    assert.equal((await plan.load()).length,2);assert.equal(calls,2);
  }
});

test('等待结束即移除取消监听，已取消的调用不启动请求',async t=>{
  let calls=0;const own=new AbortController();
  const add=t.mock.method(own.signal,'addEventListener'),remove=t.mock.method(own.signal,'removeEventListener');
  const plan=new RecordingPlan({async request(url){calls++;return {data:manifest,url};}},streams.slice(0,1));
  await plan.load(own.signal);
  assert.equal(add.mock.callCount(),1);assert.equal(remove.mock.callCount(),1);
  own.abort();await assert.rejects(plan.load(own.signal),{name:'AbortError'});assert.equal(calls,1);
});
