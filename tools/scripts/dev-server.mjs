import { createServer } from 'node:http';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,basename } from 'node:path';
import { build } from 'esbuild';
import {Input,BufferSource,MP4,Output,BufferTarget,Mp4OutputFormat,Conversion} from 'mediabunny';
const artifacts='.local/test-artifacts';
await mkdir(artifacts,{recursive:true});
await build({entryPoints:['tools/tests/browser/index.js'],outfile:`${artifacts}/browser.js`,bundle:true,format:'iife',target:'chrome110',loader:{'.html':'text','.css':'text'}});
const fixture=process.env.BILI_CLIP_FIXTURE || '.local/media/mediabunny-test.mp4';
const hlsFixture=process.env.BILI_CLIP_HLS_FIXTURE || `${artifacts}/preview-fragmented.mp4`;
if(!process.env.BILI_CLIP_HLS_FIXTURE){
 const input=new Input({source:new BufferSource(await readFile(fixture)),formats:[MP4]});
 const output=new Output({format:new Mp4OutputFormat({fastStart:'fragmented'}),target:new BufferTarget()});
 try{const conversion=await Conversion.init({input,output,copy:{mode:'forced'}});await conversion.execute();await writeFile(hlsFixture,new Uint8Array(output.target.buffer));}finally{input.dispose();}
}
createServer(async(req,res)=>{
 try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(req.method==='POST'&&path.startsWith('/artifact/')) {const chunks=[];for await(const chunk of req)chunks.push(chunk);await writeFile(resolve(artifacts,basename(path)),Buffer.concat(chunks));res.end('ok');return;}
 if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>直播片段助手 · 验证</title><style>body{font:16px system-ui;background:#eef2ed;padding:40px;color:#233532}button{padding:12px;border-radius:8px;cursor:pointer}#result{max-width:420px}</style><h1>直播片段助手</h1><p>本地验证页 · 使用实际直播素材</p><button id="test">验证浏览器视频处理</button><p id="result"></p><script src="/browser.js"></script></html>');return;}
 if(path==='/fixture.m3u8'){res.end('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:24\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:23.62,\n/raw.m4s\n#EXT-X-ENDLIST');return;}
 const files={'/browser.js':`${artifacts}/browser.js`,'/fixture.mp4':fixture,'/raw.m4s':hlsFixture,'/bella-live-clip.user.js':'bella-live-clip.user.js'};
 if(!files[path]){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript': 'video/mp4');res.end(await readFile(files[path]));
 }catch(e){res.writeHead(500);res.end(e.message);}
}).listen(Number(process.env.BILI_CLIP_PORT||8765),'127.0.0.1',()=>console.log('Preview ready'));
