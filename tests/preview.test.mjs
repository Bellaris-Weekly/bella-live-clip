import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeHlsLoader} from '../src/full-preview.js';
test('整场播放器加载分片字节区间并返回计量',async()=>{
 let options;
 const Loader=makeHlsLoader(async(url,o)=>{options=o;return {url,data:new ArrayBuffer(8)};});
 const loader=new Loader();
 await new Promise((resolve,reject)=>loader.load({url:'https://media.example/part',responseType:'arraybuffer',rangeStart:4,rangeEnd:12},{},{onSuccess(response,stats){assert.equal(response.data.byteLength,8);assert.equal(stats.loaded,8);assert.deepEqual(options.range,{offset:4,length:8});assert.equal(options.auth,undefined);resolve();},onError:reject}));
 loader.destroy();assert.equal(loader.stats.aborted,true);
});
test('切换场次取消整场播放器旧请求，不写入旧数据',async()=>{
 let finish,aborted=false,delivered=false;
 const Loader=makeHlsLoader((_,{signal})=>new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>aborted=true);}));
 const loader=new Loader();loader.load({url:'https://media.example/list',responseType:'text'},{},{onSuccess(){delivered=true;},onError(){delivered=true;}});
 loader.abort();finish({url:'https://media.example/list',data:'old'});await new Promise(r=>setImmediate(r));assert.equal(aborted,true);assert.equal(delivered,false);
});
