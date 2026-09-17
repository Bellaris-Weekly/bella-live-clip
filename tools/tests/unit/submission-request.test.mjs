import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSubmissionRequest} from '../../../src/services/submission-request.js';
import {RequestError} from '../../../src/services/retry-request.js';

test('video metadata and playback APIs use credentialed page requests without extension headers',async()=>{
  for (const path of ['/x/web-interface/view?bvid=BV1jve36mEr3','/x/player/wbi/playurl?cid=102']) {
    const request=createSubmissionRequest(async(url,options)=>{
      assert.equal(url,'https://api.bilibili.com'+path);
      assert.equal(options.credentials,'include');
      assert.equal(options.mode,'cors');
      assert.equal(options.redirect,'error');
      assert.equal(options.headers,undefined);
      return new Response('{"code":0}');
    });
    assert.equal((await request('https://api.bilibili.com'+path)).data,'{"code":0}');
  }
});

test('page credentials cannot reach media, lookalike hosts, HTTP or alternate ports',async()=>{
  const request=createSubmissionRequest(()=>assert.fail('must not send'));
  for(const url of ['https://test.bilivideo.com/media','https://api.bilibili.com.evil.test/x','http://api.bilibili.com/x','https://api.bilibili.com:8443/x']) {
    await assert.rejects(request(url),/只能发送/);
  }
});

test('HTTP errors retain status and distinguish rate limits from transient failures',async()=>{
  for(const status of [403,412,429,500,503]) {
    const request=createSubmissionRequest(async()=>new Response('',{status}));
    await assert.rejects(request('https://api.bilibili.com/x'),error=>{
      assert.ok(error instanceof RequestError);
      assert.equal(error.status,status);
      assert.equal(error.retryable,[429,500,503].includes(status));
      assert.doesNotMatch(error.message,/场次/);
      return true;
    });
  }
});

test('cancellation stops pending fetch and response-body reads without replacing the reason',async()=>{
  for(const duringBody of [false,true]) {
    const controller=new AbortController();
    let started;
    const ready=new Promise(resolve=>{started=resolve;});
    const request=createSubmissionRequest(async(_,options)=>{
      const wait=()=>new Promise((resolve,reject)=>{
        options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
        started();
      });
      return duringBody ? {ok:true,text:wait} : wait();
    });
    const pending=request('https://api.bilibili.com/x',{signal:controller.signal});
    await ready;controller.abort(new Error('cancelled'));
    await assert.rejects(pending,error=>error===controller.signal.reason);
    await assert.rejects(request('https://api.bilibili.com/x',{signal:controller.signal}),error=>error===controller.signal.reason);
  }
});
