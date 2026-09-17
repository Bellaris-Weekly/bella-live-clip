import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';

// Exercise the real entry point, replacing only application startup and network setup.
const {outputFiles}=await build({entryPoints:['src/main.js'],bundle:true,write:false,format:'iife',plugins:[{
  name:'entry-dependencies',setup(build){
    build.onResolve({filter:/^\.\/(app\/application|services\/bilibili)\.js$/},args=>({path:args.path,namespace:'stub'}));
    build.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:args.path.includes('application')
      ? 'export function createApp(options){globalThis.appOptions=options;return {open(){}};}'
      : 'export class BiliApi{};export function createRequest(){};'}));
  },
}]});

function start(pageWindow,sandboxWindow={}){
  const context={unsafeWindow:pageWindow,window:sandboxWindow,document:{getElementById:()=>null},
    GM_xmlhttpRequest(){},GM_getValue(){},GM_setValue(){},GM_registerMenuCommand(){}};
  runInNewContext(outputFiles[0].text,context);
  return context.appOptions;
}

test('userscript declares access to the real page window',()=>{
  assert.match(readFileSync(new URL('../../../src/header.txt',import.meta.url),'utf8'),/^\/\/ @grant\s+unsafeWindow\s*$/m);
});

test('save picker retains its native receiver through sandbox and detached callback calls',async()=>{
  let calls=0,active=false;
  const handle={},options={suggestedName:'整场.mp4'};
  const pageWindow={showSaveFilePicker(value){
    if(this!==pageWindow)throw new TypeError('Illegal invocation');
    assert.equal(active,true,'picker must be invoked synchronously during the click');
    assert.equal(value,options);calls++;return Promise.resolve(handle);
  }};
  const sandboxWindow={showSaveFilePicker:pageWindow.showSaveFilePicker};
  assert.throws(()=>sandboxWindow.showSaveFilePicker(options),/Illegal invocation/);
  const {saveFilePicker}=start(pageWindow,sandboxWindow);
  assert.equal(calls,0,'startup must not open the picker');
  active=true;
  const first=saveFilePicker(options);
  const second=saveFilePicker.call(sandboxWindow,options);
  assert.equal(calls,2);
  active=false;
  assert.equal(await first,handle);assert.equal(await second,handle);
});

test('an unavailable page picker stays unavailable even if the sandbox exposes one',()=>{
  for(const pageWindow of [{},{showSaveFilePicker:null}]){
    const {saveFilePicker}=start(pageWindow,{showSaveFilePicker(){assert.fail('sandbox picker must not be used');}});
    assert.equal(saveFilePicker,null);
  }
});

test('picker cancellation and permission errors propagate unchanged without retry',async()=>{
  for(const name of ['AbortError','SecurityError']){
    const error=new DOMException('Picker rejected',name);let calls=0;
    const {saveFilePicker}=start({showSaveFilePicker(){calls++;return Promise.reject(error);}});
    await assert.rejects(saveFilePicker({}),value=>value===error);
    assert.equal(calls,1);
  }
});
