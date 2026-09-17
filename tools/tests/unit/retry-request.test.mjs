import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequest} from '../../../src/services/bilibili.js';
import {RequestError,requestWithRetry,waitForRetry} from '../../../src/services/retry-request.js';

test('transport distinguishes transient network/HTTP errors from permanent failures',async()=>{
  for(const event of ['onerror','ontimeout','onabort',0,408,429,500,502,503,504,403,404]){
    const request=createRequest(options=>{
      queueMicrotask(()=>typeof event==='string'?options[event]():options.onload({status:event}));
      return {abort(){}};
    });
    await assert.rejects(request('https://example.com/media'),error=>{
      assert.ok(error instanceof RequestError);
      assert.equal(error.retryable,![403,404].includes(event));return true;
    });
  }
});

test('recovery retries only the failed read with identical URL, byte range and signal',async()=>{
  const signal=new AbortController().signal,options={signal,range:{offset:400,length:200},type:'arraybuffer'};
  const result={data:new ArrayBuffer(200)},delays=[],states=[];let calls=0;
  const api={async request(url,args){
    assert.equal(url,'https://example.com/segment');assert.equal(args,options);
    if(calls++<7)throw new RequestError('offline',{retryable:true});return result;
  }};
  assert.equal(await requestWithRetry(api,'https://example.com/segment',options,
    {wait:async delay=>delays.push(delay),onRetry:state=>states.push(state)}),result);
  assert.deepEqual(delays,[1000,2000,4000,8000,10000,10000,10000]);
  assert.equal(states.at(-1),null);assert.equal(calls,8);
});

test('permanent HTTP, invalid data and explicit cancellation never reconnect',async()=>{
  for(const error of [new RequestError('expired',{status:403}),new Error('invalid range'),new DOMException('cancel','AbortError')]){
    let calls=0;
    await assert.rejects(requestWithRetry({request:async()=>{calls++;throw error;}},'media',{},
      {wait:()=>assert.fail('must not retry')}),value=>value===error);
    assert.equal(calls,1);
  }
});

test('cancelling backoff removes the timer and stops any later retry',async()=>{
  const controller=new AbortController();let calls=0;
  const pending=requestWithRetry({request:async()=>{calls++;throw new RequestError('offline',{retryable:true});}},'media',
    {signal:controller.signal},{onRetry:state=>{if(state)queueMicrotask(()=>controller.abort());}});
  await assert.rejects(pending,error=>error===controller.signal.reason);assert.equal(calls,1);
  assert.throws(()=>waitForRetry(10000,controller.signal),error=>error===controller.signal.reason);
});

test('cancelling a live GM request aborts the transport and preserves the cancellation reason',async()=>{
  const controller=new AbortController();let aborted=false;
  const request=createRequest(options=>({abort(){aborted=true;options.onabort();}}));
  const pending=requestWithRetry({request},'https://example.com/segment',{signal:controller.signal});
  controller.abort(new DOMException('user stopped','AbortError'));
  await assert.rejects(pending,error=>error===controller.signal.reason);assert.ok(aborted);
});
