import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createDiagnosticReporter} from '../../../src/services/diagnostics.js';

// Keep real application/error boundaries; replace rendering and media work only.
const stubs = {
  'controls': 'export const createControls=()=>()=>{};',
  'record-card': 'export const createRecordCard=(record,select)=>{const card=document.createElement("div");card.onclick=select;return card;};',
  'timeline': 'export const createTimeline=()=>scenario.timeline;',
  'version': 'export const createVersionControl=()=>({refresh:async()=>{}});',
  'page-progress': 'export const bindPageProgress=()=>()=>{};',
  'export-progress': 'export const renderExportProgress=()=>{};',
  'schedule': 'export class ScheduleService{async enrich(records){return {records};}}',
  'submission': 'export const createSubmissionService=()=>({load:()=>scenario.loadVideo()});',
  'submission-storyboard': 'export const createSubmissionStoryboard=()=>({});',
  'submission-player': 'export const createSubmissionPlayer=()=>scenario.player;',
  'preview-player': 'export const createPlayer=options=>{scenario.previewOptions=options;return scenario.player;};',
  'playback': 'export const createPlayback=()=>({cancel(){}});export const bindVideoControls=()=>{};',
  'thumbnails': 'export const createThumbnails=()=>({clear(){},load(record,streams,options){scenario.thumbnailOptions=options;},setStreams(parts){scenario.thumbnailStreams=parts;},resume(){scenario.thumbnailResumes++;},update(){}});',
  'submission-export': 'export const exportSubmission=(request,record,selection,options)=>scenario.export(options);',
  'export': 'export const exportSelection=(api,record,groups,selection,options)=>scenario.export(options,groups);',
  'recording-plan': 'export class RecordingPlan{constructor(api,streams,signal){this.streams=streams;this.signal=signal;scenario.plans.push(this);}async load(){return scenario.groups;}}',
  'recording': 'export const estimateRecordingRate=async()=>{scenario.estimates++;return null;};export const estimateSelectionBytes=()=>0;export const saveRecording=(api,groups,handle,options)=>scenario.export(options,groups);',
  'temporary-media': 'export const createTemporaryMedia=()=>{};export const ensureTemporarySpace=async(...args)=>scenario.space?.(...args);',
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
  return {dataset:{},style:{},hidden:false,children:[],listeners:{},classList:{toggle(){},add(){},remove(){}},
    append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},
    querySelector:()=>null,
    get childElementCount(){return this.children.length;},focus(){},addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(){},
    setAttribute(name,value){this.attributes??={};this.attributes[name]=String(value);},getAttribute(name){return this.attributes?.[name]??null;},removeAttribute(){},getBoundingClientRect(){return {left:0,top:0,right:10,bottom:10};},
  };
}

const videoRecord={kind:'submission',key:'BV1234567890:12',bvid:'BV1234567890',cid:12,part:1,title:'Video',uploader:'Author',duration:100,media:{video:{bandwidth:8000}}};
function start({url='https://www.bilibili.com/video/BV1234567890',loadVideo=async()=>videoRecord,current=async()=>null,exportWork=async()=>{throw new Error('mux failure');},picker=async()=>({name:'saved.mp4'}),streams=[{start_time:0,end_time:100}],total=100,groups=[],clips=async()=>streams}={}) {
  let page=url;
  const nodes=new Map(),root={getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},querySelectorAll:()=>[]};
  const document={createElement:()=>({...element(),attachShadow:()=>root}),createTextNode:text=>text,
    documentElement:element(),addEventListener(){},querySelector:()=>null};
  const seeks=[];
  const scenario={loadVideo,export:exportWork,groups,plans:[],loads:[],extensions:[],selection:{start:2,end:8},thumbnailResumes:0,estimates:0,player:new Proxy({load:async(record,signal)=>{scenario.loads.push({record,signal});return {total,streams};},extend(parts){return {streams:parts,total:parts.at(-1).end_time-scenario.loads.at(-1).record.start,changed:true};},position:()=>0,isPaused:()=>true,seek:time=>seeks.push(time)},{get:(target,key)=>target[key]||(()=>{})})};
  scenario.timeline=new Proxy({getSelection:()=>({...scenario.selection}),getView:()=>({start:0,end:100}),isInteracting:()=>scenario.interacting,extend(end,options){scenario.extensions.push({end,...options});if(options.whole)scenario.selection.end=end;}},{get:(target,key)=>target[key]||(()=>{})});
  const timers=new Map();let timerId=0;
  scenario.windowEvents=[];const context={scenario,document,window:{addEventListener(name,fn){scenario.windowEvents.push(`+${name}`);(scenario.windowListeners??={})[name]=fn;},removeEventListener(name){scenario.windowEvents.push(`-${name}`);}},URL,AbortController,DOMException,
    innerWidth:1200,innerHeight:900,setInterval:()=>0,clearInterval(){},setTimeout(fn,delay){if(delay!==30000)return setTimeout(fn,delay);const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){if(!timers.delete(id))clearTimeout(id);}};
  runInNewContext(outputFiles[0].text,context);
  const requests=[];
  const diagnostics=createDiagnosticReporter({endpoint:'https://logs.example.com/v1/logs',version:'1.2.3',online:()=>true,id:()=>crypto.randomUUID(),request:options=>{requests.push(JSON.parse(options.data));options.onload({status:201});}});
  const api={request:async()=>({data:''}),history:async()=>{scenario.historyCalls=(scenario.historyCalls||0)+1;return [];},current,clips};
  const app=context.application.createApp({api,diagnostics,pageUrl:()=>page,saveFilePicker:picker,storage:{getDirectory(){}}});
  return {app,requests,seeks,scenario,timers,document,async poll(){const [id,fn]=timers.entries().next().value;timers.delete(id);await fn();},$:id=>root.getElementById(id),navigate:value=>{page=value;}};
}

test('直播首帧前不启动缩略图或大小采样，日程换对象后仍只启动一次',async()=>{
 const record={key:'live-key',uid:1,room:123,member:'成员',title:'直播',start:1000,end:1100,live:false};
 const f=start({url:'https://live.bilibili.com/123',current:async()=>record,streams:[{start_time:1000,end_time:1100,stream:'a'}]});
 await f.app.open();assert.equal(f.scenario.estimates,0);assert.equal(f.scenario.thumbnailResumes,0);assert.equal(f.scenario.thumbnailOptions.defer,true);
 f.scenario.previewOptions.onReady({...record});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.scenario.estimates,1);assert.equal(f.scenario.thumbnailResumes,1);
 f.scenario.previewOptions.onReady(record);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.scenario.estimates,1);assert.equal(f.scenario.thumbnailResumes,1);
});

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
  assert.match(fixture.$('status').textContent,/浏览器不支持保存文件/);
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

test('断流产生的多段录像可逐段选择，整场与片段只保存当前段，单段时隐藏分段', async () => {
  const record={key:'k',uid:1,room:123,member:'成员',title:'直播',start:1000,end:1300,live:false};
  const names=[],saves=[];
  const fixture=start({url:'https://live.bilibili.com/123',current:async()=>record,picker:async options=>{names.push(options.suggestedName);return {name:options.suggestedName};},
    streams:[{start_time:1000,end_time:1100,stream:'a'},{start_time:1200,end_time:1300,stream:'b'}],
    groups:[{streamIndex:0,start:1000},{streamIndex:1,start:1200}],total:300,
    exportWork:async (options,groups)=>{saves.push({...options,groups});return {saved:true,stopped:false,bytes:1,duration:100};}});
  await fixture.app.open();
  const segments=fixture.$('segments');
  assert.equal(segments.hidden,false);assert.equal(segments.children.length,2);
  assert.deepEqual(fixture.seeks,[0]);
  segments.children[1].onclick();assert.deepEqual(fixture.seeks,[0,200]);
  await fixture.$('download').onclick();
  assert.equal(saves.length,1);assert.equal(names.length,1);assert.deepEqual(saves[0].groups.map(group=>group.streamIndex),[1]);
  const clip=await saves[0].createFile({start:202,end:208,index:0,count:1});
  assert.equal(clip.name,names[0]);
  fixture.$('wholeRecording').checked=true;fixture.$('wholeRecording').onchange();
  await fixture.$('download').onclick();
  assert.equal(saves.length,2);assert.deepEqual(saves[1].groups.map(group=>group.streamIndex),[1]);
  assert.equal(names.length,2);assert.match(names[1],/_00-03-20-00-05-00_整场_第2段\.mp4$/);
  assert.equal(fixture.$('downloads').children.length,1);assert.match(fixture.$('downloads').children[0].textContent,/^已保存整场/);
  assert.equal(fixture.$('status').textContent,'导出完成。');

  const single=start({url:'https://live.bilibili.com/123',current:async()=>record,total:300,streams:[{start_time:1000,end_time:1300,stream:'a'}]});
  await single.app.open();
  assert.equal(single.$('segments').hidden,true);assert.equal(single.$('segments').children.length,0);
});

for(const url of ['https://www.bilibili.com/', 'https://live.bilibili.com/999'])test(`刷新选中的直播沿用场次身份、加入新增录像并保留选区：${url}`,async()=>{
 const record={key:'selected-live',uid:672353429,room:22632424,member:'贝拉',title:'直播',start:1000,end:1100,live:true};
 const calls=[],streams=[{start_time:1000,end_time:1100,stream:'first'}];
 const f=start({url,streams,total:300,current:async source=>{calls.push(source.room);return source.room===record.room?record:null;}});
 await f.app.open();
 if(url.includes('live.bilibili.com')){f.$('browseHistory').onclick();await new Promise(resolve=>setImmediate(resolve));}
 assert.ok(f.$('cards').children.length);
 f.$('cards').children[0].onclick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.scenario.loads.length,1);assert.deepEqual(f.seeks,[85]);calls.length=0;
 streams.push({start_time:1200,end_time:1250,stream:'latest'});
 const selection={...f.scenario.selection};
 await f.$('refreshEditor').onclick();
 assert.equal(f.scenario.loads.length,1,'刷新不能重新打开场次，否则丢失选区');
 assert.deepEqual(calls,[],'刷新录像不应重新解析所在网页的直播间');
 assert.equal(f.scenario.plans.at(-1).streams.length,2);assert.equal(f.$('segments').children.length,2);
 assert.deepEqual(f.seeks,[85],'播放位置不变');assert.deepEqual(f.scenario.selection,selection);
 assert.equal(f.requests.length,0);assert.equal(f.$('editPage').hidden,false);
 assert.match(f.$('refreshEditor').innerHTML,/glyph-refresh/);assert.equal(f.$('refreshEditor').getAttribute('aria-label'),'刷新录像');assert.equal(f.$('refreshEditor').title,'刷新录像');
});

test('不打开面板不发账号请求；鼠标移到入口才准备列表，只准备一次',async()=>{
 const f=start({url:'https://www.bilibili.com/'}),launcher=f.$('launcher');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.scenario.historyCalls??0,0);
 launcher.listeners.pointerenter();launcher.listeners.focus();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.scenario.historyCalls,1);
});

test('打开失败的录像刷新时重新打开；回放地址更新不打断大小预估',async()=>{
 const record={key:'replay',room:123,member:'成员',start:1000,end:1100,live:false};
 let clips=0;
 const f=start({url:'https://live.bilibili.com/123',current:async()=>record,streams:[{start_time:1000,end_time:1100,stream:'first'}]});
 f.scenario.player.load=async()=>{if(!clips++)throw new Error('network');return {total:100,streams:[{start_time:1000,end_time:1100,stream:'first'}]};};
 await f.app.open();assert.equal(clips,1);
 await f.$('refreshEditor').onclick();assert.equal(clips,2);
});

test('设为开始越过终点时选区延伸到录像边缘，手动输入时间校验后生效',async()=>{
 const record={key:'replay',room:123,member:'成员',start:1000,end:1100,live:false};
 const f=start({url:'https://live.bilibili.com/123',current:async()=>record,streams:[{start_time:1000,end_time:1100,stream:'first'}]});
 await f.app.open();const sets=[];
 f.scenario.timeline.setSelection=value=>{sets.push(value);};f.scenario.timeline.getBounds=()=>({start:0,end:100});f.scenario.timeline.getSelection=()=>({start:2,end:8});
 f.scenario.player.position=()=>50;
 f.$('markStart').onclick();assert.deepEqual({...sets.at(-1)},{start:50,end:100},'不能缩成一毫秒的选区');
 f.scenario.player.position=()=>1;
 f.$('markEnd').onclick();assert.deepEqual({...sets.at(-1)},{start:0,end:1});
 f.$('selectionStart').value='0:05';f.$('selectionStart').onchange();assert.deepEqual({...sets.at(-1)},{start:5,end:8});
 const count=sets.length;f.$('selectionEnd').value='abc';f.$('selectionEnd').onchange();assert.equal(sets.length,count);assert.match(f.$('status').textContent,/时间格式/);
});

test('编辑快捷键：空格播放、I / O 设起止点，输入框和整场模式下不触发',async()=>{
 const record={key:'replay',room:123,member:'成员',start:1000,end:1100,live:false};
 const f=start({url:'https://live.bilibili.com/123',current:async()=>record,streams:[{start_time:1000,end_time:1100,stream:'first'}]});
 await f.app.open();const sets=[];f.scenario.timeline.setSelection=value=>{sets.push(value);};f.scenario.timeline.getBounds=()=>({start:0,end:100});f.scenario.player.position=()=>5;
 const press=(key,extra={})=>{const event={key,target:{closest:()=>null},composedPath:()=>[],preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...extra};f.$('editPage').listeners.keydown(event);return event;};
 assert.equal(press('i').defaultPrevented,true);assert.equal(sets.length,1);
 press('O');assert.equal(sets.length,2);
 press('i',{ctrlKey:true});assert.equal(sets.length,2);
 press('i',{target:{tagName:'INPUT',closest:()=>null}});assert.equal(sets.length,2);
 f.$('wholeRecording').checked=true;press('i');assert.equal(sets.length,2);
});

test('页面进入前进后退缓存时保留面板，真正离开才销毁',async()=>{
 const f=start({url:'https://www.bilibili.com/'}),destroyed=[];
 f.scenario.player.destroy=()=>destroyed.push(true);
 f.scenario.windowListeners.pagehide({persisted:true});assert.equal(destroyed.length,0);
});

test('导出期间拦截关闭页面，结束后解除；空间不足时不开始读取',async()=>{
 const record={key:'replay',room:123,member:'成员',start:1000,end:1100,live:false};
 const f=start({url:'https://live.bilibili.com/123',current:async()=>record,streams:[{start_time:1000,end_time:1100,stream:'first'}],exportWork:async()=>{assert.ok(f.scenario.windowEvents.includes('+beforeunload'));return [];}});
 await f.app.open();f.scenario.windowEvents.length=0;
 await f.$('download').onclick();assert.deepEqual(f.scenario.windowEvents.filter(name=>name.endsWith('beforeunload')),['+beforeunload','-beforeunload']);
 let exported=false;f.scenario.space=async()=>{throw new Error('浏览器临时空间不足');};f.scenario.export=async()=>{exported=true;return [];};
 await f.$('download').onclick();assert.equal(exported,false);assert.match(f.$('status').textContent,/临时空间不足/);
});

test('直播自动增长同步分段、缩略图和导出计划，保留原选区与播放位置',async()=>{
 const record={key:'live',room:123,member:'成员',start:1000,end:1100,live:true};
 const first={start_time:1000,end_time:1100,stream:'first'},growing={...first,end_time:1150,stream:'grown'},latest={start_time:1200,end_time:1300,stream:'reconnected'};
 let parts=[growing];
 const f=start({url:'https://live.bilibili.com/123',current:async()=>record,streams:[first],clips:async()=>parts});
 await f.app.open();f.scenario.previewOptions.onReady(record);await new Promise(resolve=>setImmediate(resolve));
 const oldPlan=f.scenario.plans.at(-1),oldSelection={...f.scenario.selection},oldSeeks=[...f.seeks];
 await f.poll();
 assert.deepEqual(f.seeks,oldSeeks);assert.deepEqual(f.scenario.selection,oldSelection);assert.equal(f.scenario.loads.length,1);
 assert.equal(oldPlan.signal.aborted,true);assert.equal(f.scenario.plans.at(-1).streams[0].end_time,1150);
 assert.equal(f.scenario.thumbnailStreams[0].end_time,1150);assert.equal(f.scenario.extensions.at(-1).end,150);assert.match(f.$('clock').textContent,/02:30$/);
 parts=[growing,latest];await f.poll();
 assert.equal(f.$('segments').children.length,2);assert.equal(f.$('segments').children[0].getAttribute('aria-pressed'),'true');assert.deepEqual(f.seeks,oldSeeks);
 assert.equal(f.scenario.extensions.at(-1).end,150,'新增段不强制切走正在剪辑的旧段');
 f.$('segments').children[1].onclick();assert.equal(f.seeks.at(-1),285);
 f.scenario.groups=[{streamIndex:0,start:1000},{streamIndex:1,start:1200}];
 f.scenario.export=async(_options,groups)=>{assert.deepEqual(groups.map(group=>group.streamIndex),[1]);return {saved:true,bytes:1,duration:100};};
 f.$('wholeRecording').checked=true;f.$('wholeRecording').onchange();await f.$('download').onclick();
 assert.equal(f.requests.length,0);assert.equal(f.timers.size,1);
 f.$('close').onclick();assert.equal(f.timers.size,0);
});

test('自动增长在拖动、后台、导出、关闭时暂停；重新打开恢复，迟到请求不改动旧场次',async()=>{
 const record={key:'live',room:123,member:'成员',start:1000,end:1100,live:true};
 let finish,calls=0;
 const f=start({url:'https://live.bilibili.com/123',current:async()=>record,streams:[{start_time:1000,end_time:1100,stream:'first'}],clips:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
 await f.app.open();f.scenario.interacting=true;await f.poll();assert.equal(calls,0);
 f.scenario.interacting=false;f.document.hidden=true;await f.poll();assert.equal(calls,0);f.document.hidden=false;
 const pending=f.poll();assert.equal(calls,1);f.$('close').onclick();assert.equal(f.timers.size,0);
 finish([{start_time:1000,end_time:1200,stream:'late'}]);await pending;assert.equal(f.scenario.extensions.length,0);assert.equal(f.timers.size,0);
 await f.app.open();assert.equal(f.timers.size,1);
 let done,started;
 const gate=new Promise(resolve=>{started=resolve;});
 f.scenario.export=()=>new Promise(resolve=>{done=resolve;started();});
 const exporting=f.$('download').onclick();await gate;assert.equal(f.timers.size,0);
 done({saved:true,bytes:1,duration:6});await exporting;assert.equal(f.timers.size,1);
 f.$('back').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.timers.size,0);
});
