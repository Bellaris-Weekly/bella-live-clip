import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createDiagnosticReporter} from '../../../src/services/diagnostics.js';

// Keep real application/error boundaries; replace rendering and media work only.
const stubs = {
  'controls': 'export const createControls=()=>()=>{};',
  'record-card': 'export const createRecordCard=()=>document.createElement("div");',
  'timeline': 'export const createTimeline=()=>new Proxy({getSelection:()=>({start:2,end:8}),getView:()=>({})},{get:(target,key)=>target[key]||(()=>{})});',
  'version': 'export const createVersionControl=()=>({refresh:async()=>{}});',
  'page-progress': 'export const bindPageProgress=()=>()=>{};',
  'export-progress': 'export const renderExportProgress=()=>{};',
  'schedule': 'export class ScheduleService{async enrich(records){return {records};}}',
  'submission': 'export const createSubmissionService=()=>({load:()=>scenario.loadVideo()});',
  'submission-storyboard': 'export const createSubmissionStoryboard=()=>({});',
  'submission-player': 'export const createSubmissionPlayer=()=>scenario.player;',
  'preview-player': 'export const createPlayer=()=>scenario.player;',
  'playback': 'export const createPlayback=()=>({cancel(){}});export const bindVideoControls=()=>{};',
  'thumbnails': 'export const createThumbnails=()=>({clear(){},load(){},update(){}});',
  'submission-export': 'export const exportSubmission=(request,record,selection,options)=>scenario.export(options);',
  'export': 'export const exportSelection=(api,record,groups,selection,options)=>scenario.export(options);',
  'recording-plan': 'export class RecordingPlan{async load(){return [];}}',
  'recording': 'export const estimateRecordingRate=async()=>null;export const estimateSelectionBytes=()=>0;export const saveRecording=(api,groups,handle,options)=>scenario.export(options);',
  'temporary-media': 'export const createTemporaryMedia=()=>{};',
};
const {outputFiles} = await build({entryPoints:['src/app/application.js'],bundle:true,write:false,format:'iife',globalName:'application',
  loader:{'.txt':'text','.html':'text','.css':'text'},plugins:[{name:'render-media-fixtures',setup(build){
    build.onResolve({filter:/\.js$/},args=>{
      const match=args.path.match(/\.\.\/(ui|services|media)\/([^/]+)\.js$/);
      if(match&&stubs[match[2]])return {path:match[2],namespace:'fixture'};
    });
    build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path]}));
  }}]});

function element() {
  return {dataset:{},style:{},hidden:false,children:[],classList:{toggle(){},add(){},remove(){}},
    append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},
    get childElementCount(){return this.children.length;},focus(){},addEventListener(){},removeEventListener(){},
    setAttribute(){},removeAttribute(){},getBoundingClientRect(){return {left:0,top:0,right:10,bottom:10};},
  };
}

const videoRecord={kind:'submission',key:'BV1234567890:12',bvid:'BV1234567890',cid:12,part:1,title:'Video',uploader:'Author',duration:100,media:{video:{bandwidth:8000}}};
function start({url='https://www.bilibili.com/video/BV1234567890',loadVideo=async()=>videoRecord,current=async()=>null,exportWork=async()=>{throw new Error('mux failure');},picker=async()=>({name:'saved.mp4'})}={}) {
  let page=url;
  const nodes=new Map(),root={getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},querySelectorAll:()=>[]};
  const document={createElement:()=>({...element(),attachShadow:()=>root}),createTextNode:text=>text,
    documentElement:element(),addEventListener(){},querySelector:()=>null};
  const scenario={loadVideo,export:exportWork,player:new Proxy({load:async()=>({total:100,streams:[{start_time:0,end_time:100}]}),position:()=>0,isPaused:()=>true},{get:(target,key)=>target[key]||(()=>{})})};
  const context={scenario,document,window:{addEventListener(){},removeEventListener(){}},URL,AbortController,DOMException,
    innerWidth:1200,innerHeight:900,setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout};
  runInNewContext(outputFiles[0].text,context);
  const requests=[];
  const diagnostics=createDiagnosticReporter({endpoint:'https://logs.example.com/v1/logs',version:'1.2.3',online:()=>true,id:()=>crypto.randomUUID(),request:options=>{requests.push(JSON.parse(options.data));options.onload({status:201});}});
  const api={request:async()=>({data:''}),history:async()=>[],current};
  const app=context.application.createApp({api,diagnostics,pageUrl:()=>page,saveFilePicker:picker,directoryPicker:picker,storage:{getDirectory(){}}});
  return {app,requests,$:id=>root.getElementById(id),navigate:value=>{page=value;}};
}

test('实际导出失败在清理 abort 前上报，路由变更仍使用原始选区身份', async () => {
  let reject,started;
  const gate=new Promise(resolve=>{started=resolve;});
  const fixture=start({exportWork:options=>{options.onProgress({phase:'processing',bytes:123,estimatedBytes:456});started();return new Promise((_,no)=>{reject=no;});}});
  await fixture.app.open();
  const exporting=fixture.$('download').onclick();await gate;
  fixture.navigate('https://www.bilibili.com/video/BV0987654321');
  reject(new Error('timestamp backwards'));await exporting;
  assert.equal(fixture.requests.length,1);
  const payload=fixture.requests[0];
  assert.equal(payload.event,'export_failed');assert.equal(payload.context.record.cid,12);
  assert.equal(payload.context.page,'https://www.bilibili.com/video/BV1234567890');
  assert.equal(payload.context.selection.start,2);assert.equal(payload.context.stage,'processing');
  assert.equal(fixture.$('status').textContent,'timestamp backwards');
});

test('保存位置取消和运行中取消都保持原有 UI，均不上报', async () => {
  const pickerCancel=start({picker:async()=>{throw new DOMException('picker cancelled','AbortError');}});
  await pickerCancel.app.open();await pickerCancel.$('download').onclick();
  assert.equal(pickerCancel.requests.length,0);assert.equal(pickerCancel.$('status').textContent,'已停止。');
  let started;
  const gate=new Promise(resolve=>{started=resolve;});
  const running=start({exportWork:({signal})=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('network stopped')),{once:true});started();
  })});
  await running.app.open();const download=running.$('download').onclick();await gate;
  running.$('cancel').onclick();await download;assert.equal(running.requests.length,0);
});

test('缺少浏览器保存能力仍走统一失败入口，保留原有说明', async () => {
  const fixture=start({picker:null});
  await fixture.app.open();await fixture.$('download').onclick();
  assert.equal(fixture.requests.length,1);
  assert.equal(fixture.requests[0].context.stage,'select_destination');
  assert.match(fixture.$('status').textContent,/浏览器未开放文件保存接口/);
});

test('已捕获的视频和直播加载错误仍上报，正常未开播不当错误', async () => {
  const video=start({loadVideo:async()=>{throw new Error('video metadata unavailable');}});
  await video.app.open();assert.equal(video.requests[0].event,'video_load_failed');
  assert.equal(video.$('offlineReason').textContent,'video metadata unavailable');
  const live=start({url:'https://live.bilibili.com/123',current:async()=>{throw new Error('room API unavailable');}});
  await live.app.open();assert.equal(live.requests[0].event,'room_load_failed');
  assert.equal(live.requests[0].context.record.room,123);
  assert.equal(live.$('offlineReason').textContent,'room API unavailable');
  const offline=start({url:'https://live.bilibili.com/456'});
  await offline.app.open();assert.equal(offline.requests.length,0);
  assert.match(offline.$('offlineReason').textContent,/当前没有直播/);
});
