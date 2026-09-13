import {test} from 'node:test';
import assert from 'node:assert/strict';
import {thumbnailSamples,createThumbnails} from '../../../src/media/thumbnails.js';
const record={start:1000};
const streams=[{start_time:1000,end_time:1020,stream:'first'},{start_time:1040,end_time:1060,stream:'second'}];
const wait=()=>new Promise(resolve=>setTimeout(resolve,230));
class Element {
 children=[];textContent='';style={};
 ownerDocument={createElement:()=>new Element()};
 replaceChildren(...children){this.children=children;}
}
test('缩略图均匀采样当前窗口，断流留空，跨段转换到各自局部时间',()=>{
 const samples=thumbnailSamples(record,streams,{start:0,end:60});
 assert.deepEqual(samples.map(s=>s.time),[5,15,25,35,45,55]);
 assert.deepEqual(samples.map(s=>s.local),[5,15,null,null,5,15]);
 assert.deepEqual(samples.map(s=>s.stream?.stream),['first','first',undefined,undefined,'second','second']);
 assert.deepEqual(thumbnailSamples(record,streams,{start:40,end:46}).map(s=>s.local),[.5,1.5,2.5,3.5,4.5,5.5]);
});
test('缩放取消旧取帧且旧结果不回填，未变视野不重取，离开清空',async()=>{
 const container=new Element(),reads=[];
 const strip=createThumbnails({container,readFrame:(_,sample,signal)=>sample.time===1||sample.time===40.5?new Promise(resolve=>reads.push({sample,signal,resolve})):Promise.resolve('frame')});
 strip.load(record,streams);strip.update({start:0,end:12});await wait();
 const oldCells=container.children;assert.equal(reads.length,1);
 strip.update({start:0,end:12});await wait();assert.equal(reads.length,1);
 strip.update({start:40,end:46});assert.equal(reads[0].signal.aborted,true);
 reads[0].resolve('old');await wait();assert.equal(oldCells[0].children.length,0);assert.equal(reads.length,2);
 reads[1].resolve('new');await wait();assert.deepEqual(container.children[0].children,['new']);
 strip.clear();assert.equal(reads.at(-1).signal.aborted,true);assert.deepEqual(container.children,[]);
 reads.at(-1).resolve('late');await Promise.resolve();assert.deepEqual(container.children,[]);
});
test('无录像和加载失败有占位，其余帧继续显示，换场次重新加载',async()=>{
 const container=new Element();let calls=0;
 const strip=createThumbnails({container,readFrame:async()=>{if(++calls===1)throw new Error('network');return 'frame';}});
 strip.load(record,streams);strip.update({start:0,end:60});await wait();
 assert.equal(calls,4);assert.equal(container.children[0].textContent,'暂无预览');assert.equal(container.children[2].textContent,'无录像');assert.deepEqual(container.children[5].children,['frame']);
 strip.load(record,streams);strip.update({start:0,end:60});await wait();assert.equal(calls,8);strip.clear();
});


test('松手短暂延迟后并发生成六帧，动画只投影旧图，完成后整体替换',async()=>{
 const container=new Element(),reads=[];
 const strip=createThumbnails({container,readFrame:(_,sample,signal)=>new Promise(resolve=>reads.push({sample,signal,resolve}))});
 strip.load(record,streams);
 for(const target of [{start:0,end:12},{start:40,end:46}]){
  const offset=reads.length,view={start:0,end:60};
  strip.update(view,{animating:true,target});
  assert.equal(reads.length,offset,'保留生成前的短暂延迟');
  await wait();
  assert.equal(reads.length,offset+6,'延迟结束后六张同时启动，不等待前一张完成');
  const batch=reads.slice(offset),old=container.children;
  assert.deepEqual(batch.map(r=>r.sample.time),thumbnailSamples(record,streams,target).map(s=>s.time));
  strip.update({start:2,end:58},{animating:true,target});
  assert.equal(reads.length,offset+6);assert.equal(batch[0].signal.aborted,false);
  batch.forEach((r,i)=>r.resolve(`frame-${offset+i}`));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(container.children,old,'动画期间不切换底图');
  strip.update(target);
  assert.notEqual(container.children,old);assert.equal(reads.length,offset+6,'动画结束不重复取帧');
  assert.deepEqual(container.children.map(c=>c.children[0]),batch.map((_,i)=>`frame-${offset+i}`));
 }
 strip.clear();
});

test('新选区取消全部旧并发请求，旧结果不能回填，慢帧不阻塞其余取帧',async()=>{
 const container=new Element(),reads=[];
 const strip=createThumbnails({container,readFrame:(_,sample,signal)=>new Promise(resolve=>reads.push({signal,resolve}))});
 strip.load(record,streams);
 strip.update({start:0,end:12});await wait();
 assert.equal(reads.length,6);
 strip.update({start:40,end:46});await wait();
 assert.equal(reads.length,12);assert.ok(reads.slice(0,6).every(r=>r.signal.aborted));
 reads.slice(6).forEach(r=>r.resolve('new'));await new Promise(resolve=>setImmediate(resolve));
 const cells=container.children;assert.ok(cells.every(c=>c.children[0]==='new'));
 reads.slice(0,6).forEach(r=>r.resolve('old'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(container.children,cells);strip.clear();
});

test('延迟期间连续换选区只生成最终目标的六张图',async()=>{
 const container=new Element(),reads=[];
 const strip=createThumbnails({container,readFrame:async(_,sample)=>{reads.push(sample.time);return 'frame';}});
 strip.load(record,streams);
 strip.update({start:0,end:60},{animating:true,target:{start:0,end:12}});
 strip.update({start:0,end:60},{animating:true,target:{start:40,end:46}});
 assert.equal(reads.length,0);await wait();
 assert.deepEqual(reads,[40.5,41.5,42.5,43.5,44.5,45.5]);strip.clear();
});
