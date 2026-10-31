import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingUpdater} from '../../../src/app/recording-updater.js';

const record={key:'original-live',start:1000,live:true};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,clips){
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1100_000});
 let paused=false;
 const updates=[],calls=[];
 const updater=createRecordingUpdater({api:{clips:async(...args)=>{calls.push(args);return clips(...args);}},onUpdate:parts=>updates.push(parts),canRefresh:()=>!paused});
 t.after(()=>updater.stop());
 return {updater,updates,calls,pause(value){paused=value;},async tick(ms=30000){t.mock.timers.tick(ms);await flush();}};
}
test('polls the same live key with a growing request range; never overlaps slow requests',async t=>{
 let finish;
 const f=fixture(t,()=>new Promise(resolve=>{finish=resolve;}));
 f.updater.start(record);await f.tick(29999);assert.equal(f.calls.length,0);
 await f.tick(1);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],record);assert.equal(f.calls[0][2],130);
 await f.tick(90000);assert.equal(f.calls.length,1);
 finish(['first']);await flush();assert.deepEqual(f.updates,[['first']]);
 await f.tick();assert.equal(f.calls.length,2);assert.equal(f.calls[1][2],250);
 f.updater.stop();assert.equal(f.calls[1][3].aborted,true);finish(['late']);await flush();assert.equal(f.updates.length,1);
});
test('hidden, busy or dragging states skip polls and discard responses until safe to apply',async t=>{
 let finish;
 const f=fixture(t,()=>new Promise(resolve=>{finish=resolve;}));
 f.updater.start(record);f.pause(true);await f.tick();assert.equal(f.calls.length,0);
 f.pause(false);await f.tick();assert.equal(f.calls.length,1);
 f.pause(true);finish(['busy-result']);await flush();assert.equal(f.updates.length,0);
 f.pause(false);await f.tick();finish(['fresh']);await flush();assert.deepEqual(f.updates,[['fresh']]);
});
test('switching sessions aborts the old poll and late transport completion cannot restart it',async t=>{
 let old;
 const f=fixture(t,owner=>owner.key===record.key?new Promise(resolve=>{old=resolve;}):Promise.resolve(['new']));
 f.updater.start(record);await f.tick();
 f.updater.start({...record,key:'new-live'});assert.equal(f.calls[0][3].aborted,true);
 old(['old']);await flush();await f.tick();assert.deepEqual(f.updates,[['new']]);assert.equal(f.calls.length,2);
 f.updater.stop();await f.tick(90000);assert.equal(f.calls.length,2);
});
test('replays renew their addresses rarely, before the platform expires them',async t=>{
 const f=fixture(t,async()=>['renewed']),replay={...record,live:false,end:1500};
 f.updater.start(replay);await f.tick(1199999);assert.equal(f.calls.length,0);
 await f.tick(1);assert.equal(f.calls.length,1);assert.equal(f.calls[0][2],500);assert.deepEqual(f.updates,[['renewed']]);
});
test('exports renew stale addresses first, and only those',async t=>{
 const f=fixture(t,async()=>['renewed']),signal=new AbortController().signal,replay={...record,live:false,end:1500};
 f.updater.start(replay,{fresh:true});f.updater.stop();
 await f.updater.ensureFresh(replay,signal);assert.equal(f.calls.length,0);
 t.mock.timers.tick(1200000);await f.updater.ensureFresh(replay,signal);assert.equal(f.calls.length,1);assert.deepEqual(f.updates,[['renewed']]);
 await f.updater.ensureFresh(replay,signal);assert.equal(f.calls.length,1,'the renewal counts as fresh');
});
test('a failed renewal does not stop an export, but cancelling does',async t=>{
 const f=fixture(t,async()=>{throw new Error('network');}),controller=new AbortController();
 t.mock.timers.tick(1200000);await f.updater.ensureFresh(record,controller.signal);assert.equal(f.calls.length,1);
 controller.abort();await assert.rejects(f.updater.ensureFresh(record,controller.signal),{name:'AbortError'});
});
test('a manual refresh applies immediately and cancels nothing else',async t=>{
 const f=fixture(t,async()=>['manual']);
 f.updater.start(record);await f.updater.refresh(record,new AbortController().signal);assert.deepEqual(f.updates,[['manual']]);
 await f.tick();assert.equal(f.calls.length,2,'polling continues');
});
test('temporary API failures retry without clearing usable footage',async t=>{
 let fail=true;
 const f=fixture(t,async()=>{if(fail)throw new Error('network');return ['recovered'];});
 f.updater.start(record);await f.tick();assert.equal(f.updates.length,0);
 fail=false;await f.tick();assert.deepEqual(f.updates,[['recovered']]);
});
