import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticReporter} from '../../../src/services/diagnostics.js';
import worker from '../../../src/server/logs-worker.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const endpoint = 'https://logs.example.com/v1/logs';
function setup(overrides = {}) {
  const requests = [];
  const reporter = createDiagnosticReporter({endpoint, version:'1.2.3', userAgent:'Test/1',
    id:()=> 'stable-event', online:()=>true, wait:async()=>{},
    request: options => {requests.push(options); options.onload({status:201});}, ...overrides});
  return {reporter,requests};
}

test('快照保留失败操作身份，白名单不带媒体/会话，敏感文字在发送前清理', async () => {
  const {reporter, requests} = setup();
  const record = {kind:'submission',key:'old-part',bvid:'BV1234567890',cid:12,media:{url:'https://secret.example/video?token=never'},Cookie:'never'};
  const selection = {start:12,end:20};
  const operation = reporter.begin('export',{pageUrl:'https://www.bilibili.com/video/BV1234567890?p=2&tracking=never',record,selection,mode:'precise'});
  record.key='new-part'; selection.start=900;
  operation.stage('preparing'); operation.progress({phase:'processing',bytes:100,progress:.25,cookie:'never'});
  const error = new Error('failed Authorization: Bearer secret-text');
  error.stack = 'Error at https://cdn.example.com/segment?token=stack-secret&newSignatureScheme=unknown-signature&cid=12#opaque-fragment';
  assert.equal(operation.fail(error),undefined);
  await settle();
  assert.equal(requests.length,1);
  const options=requests[0], payload=JSON.parse(options.data);
  assert.equal(options.anonymous,true); assert.equal(options.timeout,8000);
  assert.deepEqual(options.headers,{'Content-Type':'application/json'});
  assert.equal(payload.context.record.key,'old-part'); assert.equal(payload.context.selection.start,12);
  assert.equal(payload.context.page,'https://www.bilibili.com/video/BV1234567890?p=2');
  assert.equal(payload.context.stage,'processing'); assert.equal(payload.context.progress.bytes,100);
  assert.ok(!options.data.includes('secret-text')&&!options.data.includes('stack-secret')&&!options.data.includes('never'));
  assert.ok(!options.data.includes('unknown-signature')&&!options.data.includes('opaque-fragment'));
  assert.equal(payload.context.stack,'Error at https://cdn.example.com/segment');
  const response=await worker.fetch(new Request(endpoint,{method:'POST',headers:options.headers,body:options.data}),{
    LOGS_DB:{prepare(){return {bind(){return {async run(){return {success:true,meta:{changes:1}};}};}};}}});
  assert.equal(response.status,201,'real backend validates the emitted contract');
});

test('失败重试使用相同事件与内容，永久拒绝不重试，重复fail不重复发送', async () => {
  for (const status of [503,429,400,413]) {
    const requests=[];
    const {reporter}=setup({request:options=>{requests.push(options);options.onload({status});}});
    const operation=reporter.begin('export');operation.fail(new Error('failed'));operation.fail(new Error('again'));
    await settle();
    assert.equal(requests.length,status>=500||status===429?2:1);
    if(requests.length===2)assert.equal(requests[0].data,requests[1].data);
  }
});

test('取消、离线和无配置不上传；同步请求异常和网络失败不会逃逸', async () => {
  const {reporter,requests}=setup();
  reporter.begin('export').fail(new DOMException('cancel','AbortError'));
  const controller=new AbortController();controller.abort();
  reporter.begin('export').fail(new Error('generic cancellation'),controller.signal);
  setup({online:()=>false,request:()=>assert.fail('offline request')}).reporter.begin('export').fail(new Error('offline'));
  createDiagnosticReporter().begin('export').fail(new Error('unconfigured'));
  assert.equal(requests.length,0);
  for(const request of [()=>{throw new Error('transport');},options=>options.onerror(),options=>options.ontimeout()]) {
    assert.doesNotThrow(()=>setup({request}).reporter.begin('load').fail(new Error('actual failure')));
  }
  await settle();
});

test('没有无限队列：两条待上传占满后丢弃新增，完成后恢复', async () => {
  const requests=[];
  const {reporter}=setup({request:options=>requests.push(options)});
  for(let i=0;i<100;i++)reporter.begin('export').fail(new Error('failed'));
  assert.equal(requests.length,2);
  requests[0].onload({status:201});await settle();
  reporter.begin('export').fail(new Error('next'));assert.equal(requests.length,3);
  requests[1].onload({status:201});requests[2].onload({status:201});await settle();
});

test('超长多字节和 JSON 转义错误仍满足实际 UTF8 限制', async () => {
  for(const unit of ['汉','\u0000']) {
    const {reporter,requests}=setup();
    const error=new Error(unit.repeat(60000));error.stack=unit.repeat(60000);
    reporter.begin('export').fail(error);await settle();
    assert.equal(requests.length,1);
    assert.ok(new TextEncoder().encode(requests[0].data).byteLength<=65536);
    assert.ok(JSON.parse(requests[0].data).message.length<=16384);
  }
});
