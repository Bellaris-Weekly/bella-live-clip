// Runs against the full application, including asynchronous schedule enrichment.
export async function runCardChecks(app, query) {
 const result=document.getElementById('result'),root=app.root;
 const assert=(condition,message)=>{if(!condition)throw new Error(message);};
 const until=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('等待界面超时');};
 const checks=[];
 try{
  await until(()=>root.querySelectorAll('.record-card').length===6&&!root.getElementById('refreshLibrary').disabled);
  await until(()=>query.has('schedule-error')?root.getElementById('scheduleNote').textContent.includes('暂不可用'):root.querySelectorAll('.record-type').length===5);
  const cards=[...root.querySelectorAll('.record-card')];
  assert(!root.querySelector('.cover'),'仍然显示封面');
  assert(cards[0].querySelector('.card-title').textContent==='【3D】今晚一起唱歌','原标题被替换');
  assert(cards.every(c=>c.querySelector('.record-duration').textContent===(query.has('timeline')?'01:22:56':'00:00:24')),'没有使用实际时长');
  assert(cards.every(c=>!/贝拉|嘉然|乃琳/.test(c.textContent)),'卡片出现姓名文字');
  assert(!cards[5].querySelector('.record-type')&&!cards[5].querySelector('.participant'),'无日程时猜测了参与者');
  assert(cards.every(c=>c.scrollWidth<=c.clientWidth),'卡片横向溢出');
  const panelWidth=root.getElementById('panel').clientWidth;
  const expectedColumns=panelWidth<350?1:panelWidth>=720?3:2;
  const firstRow=cards.filter(c=>Math.abs(c.getBoundingClientRect().top-cards[0].getBoundingClientRect().top)<1);
  assert(firstRow.length===expectedColumns,'卡片列数错误');
  const grid=root.getElementById('cards').getBoundingClientRect();
  assert(Math.abs(firstRow[0].getBoundingClientRect().left-grid.left)<1&&Math.abs(firstRow.at(-1).getBoundingClientRect().right-grid.right)<1,'卡片两侧留下多余空白');
  assert(cards[0].querySelector('.card-date').textContent==='1209月 · 周六19:36','日期块北京时间错误');
  checks.push('无封面、原标题、无可见姓名、实际时长、未匹配回退、布局无溢出');
  if(!query.has('schedule-error')){
   assert(cards[0].querySelectorAll('.participant').length===3,'团播头像数量错误');
   assert(cards[3].querySelectorAll('.participant').length===2,'双播头像数量错误');
   assert(cards[2].querySelectorAll('.participant').length===1,'单播头像数量错误');
   checks.push('团播、双播、单播头像数量');
  }
  root.querySelector('[data-member="xinyi"]').click();
  await until(()=>root.querySelector('[data-member="xinyi"]').getAttribute('aria-pressed')==='true'&&!root.getElementById('refreshLibrary').disabled);
  assert(!root.querySelector('.record-type')&&!root.querySelector('.participant'),'其他成员残留日程');
  checks.push('切换成员无日程串场');
  if(query.has('slow-schedule')){
   root.querySelector('[data-member="bella"]').click();
   await until(()=>!root.getElementById('refreshLibrary').disabled);
   root.getElementById('refreshLibrary').click();
   await until(()=>!root.getElementById('refreshLibrary').disabled);
   root.querySelector('[data-member="sinuo"]').click();
   await new Promise(resolve=>setTimeout(resolve,1300));
   assert(root.querySelector('[data-member="sinuo"]').getAttribute('aria-pressed')==='true'&&!root.querySelector('.record-type'),'迟到的日程污染当前成员');
   checks.push('日程加载中切换成员取消旧请求');
  }
  root.querySelector('[data-member="bella"]').click();
  await until(()=>!root.getElementById('refreshLibrary').disabled);
  if(query.has('slow-schedule')){
   root.getElementById('refreshLibrary').click();
   await until(()=>!root.getElementById('refreshLibrary').disabled);
  }
  root.querySelector('.record-card').click();
  await until(()=>!root.getElementById('editPage').hidden&&!root.getElementById('back').disabled);
  if(query.has('slow-schedule'))await new Promise(resolve=>setTimeout(resolve,1300));
  assert(root.getElementById('recordTitle').textContent==='【3D】今晚一起唱歌','进入录像后标题改变');
  assert(!root.getElementById('editPage').hidden,'迟到日程打断了录像页');
  assert(Number(root.getElementById('startHandle').getAttribute('aria-valuenow'))===0,'默认选区起点错误');
  assert(Number(root.getElementById('endHandle').getAttribute('aria-valuenow'))===(query.has('timeline')?4976:24),'默认选区未覆盖整场');
  const durationNode=root.getElementById('selectionDuration'),sizeNode=root.getElementById('estimatedSize');
  assert(!/选中|预估/.test(durationNode.textContent+sizeNode.textContent),'摘要仍有多余前缀');
  for(const prop of ['fontSize','fontWeight','color'])assert(getComputedStyle(durationNode)[prop]===getComputedStyle(sizeNode)[prop],'摘要文字样式不同');
  checks.push('默认整场选区与统一摘要样式');
  if(!query.has('schedule-error'))await until(()=>root.getElementById('recordMeta').textContent.endsWith('团播'));
  assert(!/历史回放|本场直播/.test(root.getElementById('recordMeta').textContent),'场次信息仍显示来源标签');
  const precise=root.querySelector('[data-mode="precise"]'),copy=root.querySelector('[data-mode="copy"]');
  precise.click();assert(precise.getAttribute('aria-pressed')==='true'&&copy.getAttribute('aria-pressed')==='false','精确模式切换失败');
  root.getElementById('wholeRecording').click();assert(root.getElementById('exportMode').hidden,'整场模式未隐藏切换');
  root.getElementById('wholeRecording').click();assert(!root.getElementById('exportMode').hidden&&precise.getAttribute('aria-pressed')==='true','退出整场后模式丢失');
  copy.click();assert(copy.getAttribute('aria-pressed')==='true','原画模式切换失败');
  assert(!root.querySelector('.export-section .hint')&&!root.querySelector('select#exportMode'),'旧导出说明或下拉框仍存在');
  checks.push('直播类型、双选项切换和整场模式恢复');
  root.getElementById('back').click();
  await until(()=>!root.getElementById('library').hidden&&!root.getElementById('refreshLibrary').disabled);
  checks.push('选择录像与返回列表');
  result.textContent='通过：'+checks.join('；');
  await fetch('/artifact/cards-browser-results'+(query.has('narrow')?'-narrow':'')+(query.has('schedule-error')?'-fallback':'')+(query.has('slow-schedule')?'-race':'')+'.json',{method:'POST',body:JSON.stringify({passed:true,checks})});
 }catch(error){result.textContent='失败：'+error.message;}
}
