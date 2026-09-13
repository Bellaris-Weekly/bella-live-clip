// Run with ?slow-media to keep estimates pending while navigating and refreshing.
export async function runSessionChecks(app,reads){
 const root=app.root,$=id=>root.getElementById(id),result=document.getElementById('result');
 const assert=(value,message)=>{if(!value)throw new Error(message);};
 const until=async condition=>{for(let i=0;i<160;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('等待场次状态超时');};
 const editable=()=>!$('editPage').hidden&&!$('back').disabled;
 try{
  await until(()=>root.querySelectorAll('.record-card').length===6&&!$('refreshLibrary').disabled);
  root.querySelectorAll('.record-card')[0].click();
  await until(()=>editable()&&reads.some(read=>!read.settled));
  const pending=reads.filter(read=>!read.settled);
  $('back').click();
  assert(pending.every(read=>read.signal.aborted),'返回未取消旧场次的媒体请求');
  await until(()=>!$('library').hidden&&!$('refreshLibrary').disabled);
  assert($('clock').textContent==='0:00 / 0:00','返回后时钟没有重置');
  root.querySelectorAll('.record-card')[1].click();
  await until(()=>editable()&&$('estimatedSize').textContent.startsWith('约 '));
  assert($('recordTitle').textContent==='【突击】看看测试服！','旧场次覆盖新标题');
  assert($('status').dataset.error!=='true','旧请求失败污染了新场次');
  const label=$('download').querySelector('span'),icon=$('download').querySelector('svg');
  $('wholeRecording').click();assert(label.textContent==='导出整场','整场按钮文本未更新');
  const before=reads.length;
  $('refreshEditor').click();
  await until(()=>editable()&&reads.length>before&&$('estimatedSize').textContent.startsWith('约 '));
  assert(!$('wholeRecording').checked&&label.textContent==='导出','刷新后整场状态未重置');
  assert($('download').querySelector('span')===label&&$('download').querySelector('svg')===icon,'状态刷新重建了按钮');
  $('close').click();await app.open();
  assert(editable(),'收起再打开丢失当前场次');
  $('back').click();await until(()=>!$('library').hidden);
  const checks=['预估中返回取消旧请求','切换场次无迟到更新','刷新重建清单并重置整场状态','按钮节点保持不变','收起再打开保留场次'];
  result.textContent='通过：'+checks.join('；');
  await fetch('/artifact/session-browser-results.json',{method:'POST',body:JSON.stringify({passed:true,checks})});
 }catch(error){result.textContent='失败：'+error.message;}
}
