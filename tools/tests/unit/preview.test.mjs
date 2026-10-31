import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeHlsLoader,createPlayer} from '../../../src/media/preview-player.js';
test('整场播放器加载分片字节区间并返回计量',async()=>{
 let options;
 const Loader=makeHlsLoader(async(url,o)=>{options=o;return {url,data:new ArrayBuffer(8)};});
 const loader=new Loader();
 await new Promise((resolve,reject)=>loader.load({url:'https://media.example/part',responseType:'arraybuffer',rangeStart:4,rangeEnd:12},{},{onSuccess(response,stats){assert.equal(response.data.byteLength,8);assert.equal(stats.loaded,8);assert.deepEqual(options.range,{offset:4,length:8});assert.equal(options.auth,undefined);resolve();},onError:reject}));
 loader.destroy();assert.equal(loader.stats.aborted,true);
});

function playerFixture(clips){
 const instances=[],shown=[];
 class FakeHls {
  constructor(config){this.config=config;this.events=new Map();instances.push(this);}
  on(event,handler){this.events.set(event,handler);}
  loadSource(url){this.url=url;}
  attachMedia(video){this.video=video;}
  destroy(){this.destroyed=true;}
 }
 const video=new EventTarget();Object.assign(video,{currentTime:0,readyState:0,seeking:false,pause(){},removeAttribute(){},load(){this.currentTime=0;}});
 const loading={hidden:true};
 const player=createPlayer({video,loading,api:{clips,request(){}},status(){},onTime(){},onReady:owner=>shown.push(owner),HlsClass:FakeHls});
 return {player,video,loading,instances,shown};
}

test('initial preview starts only the selected segment at its requested position',async()=>{
 const record={start:1000,end:1300,live:false},parts=[{start_time:1000,end_time:1100,stream:'first'},{start_time:1200,end_time:1300,stream:'latest'}];
 const f=playerFixture(async()=>parts),signal=new AbortController().signal;
 assert.deepEqual(await f.player.load(record,signal),{streams:parts,total:300});
 assert.equal(f.instances.length,0,'do not load the first segment before the initial selection');
 f.player.seek(285);assert.equal(f.instances.length,1);assert.equal(f.instances[0].url,'latest');assert.equal(f.instances[0].config.startPosition,85);
 f.instances[0].events.get('hlsManifestParsed')();assert.equal(f.video.currentTime,85);
 f.video.dispatchEvent(new Event('canplay'));assert.equal(f.shown.length,0);
 f.video.readyState=2;f.video.dispatchEvent(new Event('loadeddata'));assert.deepEqual(f.shown,[record]);assert.equal(f.loading.hidden,true);
 f.video.dispatchEvent(new Event('canplay'));assert.equal(f.shown.length,1);
 f.player.seek(250);assert.equal(f.instances.length,1);assert.equal(f.video.currentTime,50);
 f.player.seek(10);assert.equal(f.instances.length,2);assert.equal(f.instances[0].destroyed,true);assert.equal(f.instances[1].url,'first');
 f.player.destroy();
});

test('late clip lists cannot replace the newly loaded record',async()=>{
 let finish,calls=0;
 const parts=[{start_time:2000,end_time:2100,stream:'new'}];
 const f=playerFixture(()=>++calls===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve(parts));
 const signal=new AbortController().signal,old=f.player.load({start:1000,end:1100},signal);
 const rejected=assert.rejects(old,{name:'AbortError'});
 await f.player.load({start:2000,end:2100},signal);
 finish([{start_time:1000,end_time:1100,stream:'old'}]);await rejected;
 f.player.seek(10);assert.equal(f.instances[0].url,'new');f.player.destroy();
});
test('切换场次取消整场播放器旧请求，不写入旧数据',async()=>{
 let finish,aborted=false,delivered=false;
 const Loader=makeHlsLoader((_,{signal})=>new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>aborted=true);}));
 const loader=new Loader();loader.load({url:'https://media.example/list',responseType:'text'},{},{onSuccess(){delivered=true;},onError(){delivered=true;}});
 loader.abort();finish({url:'https://media.example/list',data:'old'});await new Promise(r=>setImmediate(r));assert.equal(aborted,true);assert.equal(delivered,false);
});
