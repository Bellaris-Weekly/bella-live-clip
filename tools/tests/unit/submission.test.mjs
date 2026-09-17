import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseSubmissionUrl,normalizeSubmission} from '../../../src/domain/submission.js';
import {createSubmissionService,md5,signWbi} from '../../../src/services/submission.js';
import {createRequest} from '../../../src/services/bilibili.js';

const images = {img_url:'https://i.example/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png'};
const ids = ['BV1SNYq6gEQh','BV1xx411c7mD'];
const metadata = (bvid=ids[0]) => ({bvid,aid:123,title:'视频标题',owner:{name:'作者'},pages:[{page:1,cid:101,duration:60,part:'第一部分'},{page:2,cid:102,duration:90,part:'第二部分'}]});
const stream = (id,codecs,bandwidth) => ({id,codecs,bandwidth,baseUrl:`https://test.bilivideo.com/${id}`,backupUrl:[`http://backup.bilivideo.cn/${id}`]});
const play = () => ({timelength:90000,quality:120,support_formats:[{quality:80,new_description:'1080P'},{quality:64,new_description:'720P'}],dash:{video:[stream(120,'hev1.1.6',3000),stream(64,'avc1.640028',900),stream(80,'avc1.640032',1500)],audio:[stream(30216,'mp4a.40.2',64000),stream(30280,'mp4a.40.2',192000)]}});

test('recognizes two video identities, av IDs and current parts without accepting foreign routes',()=>{
 for(const bvid of ids) assert.deepEqual(parseSubmissionUrl(`https://www.bilibili.com/video/${bvid}/?p=2`),{bvid,part:2,key:`${bvid}:2`});
 assert.deepEqual(parseSubmissionUrl('https://www.bilibili.com/video/av123'),{aid:'123',part:1,key:'av123:1'});
 for(const value of ['https://evil.example/video/'+ids[0],'https://www.bilibili.com/bangumi/play/ep1','https://www.bilibili.com/video/'+ids[0]+'?p=0','https://www.bilibili.com/video/'+ids[0]+'?p=1.5']) assert.equal(parseSubmissionUrl(value),null);
});

test('highest accessible AVC/AAC is used and quality describes actual selected video',()=>{
 for(const bvid of ids){
  const result=normalizeSubmission(metadata(bvid),{bvid,part:2},play());
  assert.equal(result.key,`${bvid}:102`);assert.equal(result.cid,102);assert.equal(result.partTitle,'第二部分');assert.equal(result.duration,90);
  assert.equal(result.qualityLabel,'1080P');assert.equal(result.media.video.url,'https://test.bilivideo.com/80');assert.equal(result.media.audio.bandwidth,192000);
  assert.equal(result.media.video.backupUrls[0],'https://backup.bilivideo.cn/80');assert.equal(result.referer,`https://www.bilibili.com/video/${bvid}/?p=2`);
 }
});

test('wrong identity, missing part, access preview and incompatible tracks fail truthfully',()=>{
 const route={bvid:ids[0],part:2};
 assert.throws(()=>normalizeSubmission(metadata(ids[1]),route,play()),/不一致/);
 assert.throws(()=>normalizeSubmission(metadata(),{...route,part:3},play()),/分 P 不存在/);
 assert.throws(()=>normalizeSubmission(metadata(),route,{...play(),is_preview:1}),/试看/);
 for(const codecs of ['hev1.1.6','av01.0.08']){const p=play();p.dash.video=[stream(120,codecs,100)];assert.throws(()=>normalizeSubmission(metadata(),route,p),/H.264/);}
 for(const codecs of ['fLaC','ec-3']){const p=play();p.dash.audio=[stream(1,codecs,100)];assert.throws(()=>normalizeSubmission(metadata(),route,p),/AAC/);}
 const p=play();delete p.dash.audio;assert.throws(()=>normalizeSubmission(metadata(),route,p),/音轨信息/);
});

test('explicit silent DASH and combined MP4 are separate supported cases',()=>{
 const p=play();p.dash.audio=[];
 assert.equal(normalizeSubmission(metadata(),{part:1},p).media.audio,null);
 const combined=normalizeSubmission(metadata(),{part:1},{format:'mp4',quality:64,timelength:60000,durl:[{url:'http://test.bilivideo.com/movie.mp4'}]});
 assert.deepEqual(combined.media,{video:{url:'https://test.bilivideo.com/movie.mp4',bandwidth:0,backupUrls:[]},audio:null,combined:true});
 assert.throws(()=>normalizeSubmission(metadata(),{part:1},{format:'flv',durl:[{url:'https://test.bilivideo.com/movie.flv'}]}),/DASH/);
});

test('WBI MD5 matches independent standard implementation across block boundaries and Unicode',()=>{
 for(const text of ['', 'a','abc','x'.repeat(55),'x'.repeat(56),'x'.repeat(64),'x'.repeat(1000),'中文 checksum']) assert.equal(md5(text),createHash('md5').update(text).digest('hex'));
 const params=signWbi({foo:'114',bar:'514',baz:1919810},images,1702204169000);
 assert.equal(params.get('w_rid'),'6149fdadf571698ca7e6a567265cd0ee');
});

test('load resolves current metadata/part via API and does not reuse stale page globals',async()=>{
 for(const bvid of ids){
  const calls=[];
  const service=createSubmissionService(async(url,options)=>{
   const u=new URL(url);calls.push({u,options});
   const data=u.pathname.endsWith('/view')?metadata(bvid):u.pathname.endsWith('/nav')?{wbi_img:images}:play();
   return {data:JSON.stringify({code:u.pathname.endsWith('/nav')?-101:0,data})};
  });
  const result=await service.load(`https://www.bilibili.com/video/${bvid}?p=2`,{context:{__playinfo__:{data:play()},cid:999}});
  assert.equal(result.cid,102);assert.equal(calls.length,3);assert.equal(calls[2].u.searchParams.get('cid'),'102');assert.equal(calls[2].u.searchParams.get('bvid'),bvid);
  assert.ok(calls[2].u.searchParams.get('w_rid'));assert.ok(calls.every(({options})=>options.auth&&options.referer.includes(bvid)));
 }
});

test('service preserves cancellation, rejects access errors and invalid API bodies',async()=>{
 for(const code of [-403,-10403,-101,-404]){
  const service=createSubmissionService(async()=>({data:JSON.stringify({code})}));
  await assert.rejects(service.load(`https://www.bilibili.com/video/${ids[0]}`),/权限|登录|删除/);
 }
 const abort=new AbortController();abort.abort();let requested=false;
 const service=createSubmissionService(async()=>{requested=true;return {data:'bad'};});
 await assert.rejects(service.load(`https://www.bilibili.com/video/${ids[0]}`,{signal:abort.signal}),error=>error===abort.signal.reason);assert.equal(requested,false);
 await assert.rejects(service.load(`https://www.bilibili.com/video/${ids[0]}`),/接口数据/);
});

test('authenticated requests only reach exact live/video API origins while media remains anonymous',async()=>{
 const seen=[];const request=createRequest(options=>{seen.push(options);queueMicrotask(()=>options.onload({status:200,responseText:'ok'}));return {abort(){}};});
 await request('https://api.bilibili.com/x/web-interface/view',{auth:true,referer:'https://www.bilibili.com/video/example'});
 await request('https://test.bilivideo.com/1',{referer:'https://www.bilibili.com/video/example'});
 assert.equal(seen[0].anonymous,false);assert.equal(seen[1].anonymous,true);assert.equal(seen[0].headers.Referer,'https://www.bilibili.com/video/example');
 for(const url of ['http://api.bilibili.com/x','https://api.bilibili.com.evil.example/x','https://api.bilibili.com:8443/x','https://test.bilivideo.com/x']) await assert.rejects(request(url,{auth:true}),/账号请求/);
 assert.equal(seen.length,2);
});


test('unfamiliar and peer CDN primaries select permitted standard backups without changing signed paths',()=>{
 const cases=[
  ['https://peer.edge.mountaintoys.cn:4483/video','https://up-test.bilivideo.com/video?token=fake%2Fvalue&x=1+2'],
  ['https://peer.mcdn.bilivideo.cn:8082/video','http://up-other.acgvideo.com/video?token=fake%2bvalue&x=3'],
 ];
 for(const [primary,backup] of cases){
  const p=play();p.dash.video=[{...stream(80,'avc1.640032',1500),baseUrl:primary,backupUrl:[backup,'https://backup.hdslb.com/video?x=1']}];
  const result=normalizeSubmission(metadata(),{part:1},p);
  assert.equal(result.media.video.url,backup.replace(/^http:/,'https:'));
  assert.deepEqual(result.media.video.backupUrls,['https://backup.hdslb.com/video?x=1']);
 }
});

test('unsupported-only media hosts and domain lookalikes fail without widening authenticated origins',()=>{
 for(const url of ['https://unknown.example/video','https://evilbilivideo.com/video','https://bilivideo.com.evil.example/video','https://peer.bilivideo.cn:8082/video']){
  const p=play();p.dash.video=[{...stream(80,'avc1.640032',1500),baseUrl:url,backupUrl:[]}];
  assert.throws(()=>normalizeSubmission(metadata(),{part:1},p),/CDN/);
 }
});


test('preview uses lowest AVC/AAC while export retains highest, regardless of API order',()=>{
 for(const [low,high] of [[16,80],[32,120]]) {
  const p=play();
  p.dash.video=[stream(high,'avc1.640032',8000),stream(low,'avc1.640028',400),stream(low,'avc1.640028',200),stream(high,'avc1.640032',9000)];
  p.dash.audio.reverse();
  const result=normalizeSubmission(metadata(),{part:1},p);
  assert.equal(result.previewMedia.video.url,`https://test.bilivideo.com/${low}`);
  assert.equal(result.previewMedia.video.bandwidth,200);
  assert.equal(result.previewMedia.audio.bandwidth,64000);
  assert.equal(result.media.video.url,`https://test.bilivideo.com/${high}`);
  assert.equal(result.media.video.bandwidth,9000);
  assert.equal(result.media.audio.bandwidth,192000);
 }
});

test('single representation and silent videos retain explicit preview sources',()=>{
 const p=play();p.dash.video=[stream(16,'avc1.640028',400)];p.dash.audio=[];
 const result=normalizeSubmission(metadata(),{part:1},p);
 assert.deepEqual(result.previewMedia,result.media);
 const combined=normalizeSubmission(metadata(),{part:1},{format:'mp4',quality:64,timelength:60000,durl:[{url:'https://test.bilivideo.com/movie.mp4'}]});
 assert.equal(combined.previewMedia,combined.media);
 assert.equal(combined.previewQualityLabel,combined.qualityLabel);
});
