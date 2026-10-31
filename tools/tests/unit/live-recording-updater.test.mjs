import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLiveRecordingUpdater} from '../../../src/app/live-recording-updater.js';

const record={key:'original-live',start:1000,live:true};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,clips){
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1100_000});
 let paused=false;
 const updates=[],calls=[];
 const updater=createLiveRecordingUpdater({api:{clips:async(...args)=>{calls.push(args);return clips(...args);}},onUpdate:parts=>updates.push(parts),canRefresh:()=>!paused});
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
test('temporary API failures retry without clearing usable footage; historical records do not poll',async t=>{
 let fail=true;
 const f=fixture(t,async()=>{if(fail)throw new Error('network');return ['recovered'];});
 f.updater.start({...record,live:false});await f.tick();assert.equal(f.calls.length,0);
 f.updater.start(record);await f.tick();assert.equal(f.updates.length,0);
 fail=false;await f.tick();assert.deepEqual(f.updates,[['recovered']]);
});
