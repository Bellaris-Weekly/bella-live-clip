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
  assert(cards.every(c=>c.querySelector('.record-duration').textContent==='00:00:24'),'没有使用实际时长');
  assert(cards.every(c=>!/贝拉|嘉然|乃琳/.test(c.textContent)),'卡片出现姓名文字');
  assert(!cards[5].querySelector('.record-type')&&!cards[5].querySelector('.participant'),'无日程时猜测了参与者');
  assert(cards.every(c=>c.scrollWidth<=c.clientWidth),'卡片横向溢出');
  assert(cards.every(c=>c.getBoundingClientRect().width<=244),'卡片超过宽度上限');
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
  root.getElementById('back').click();
  await until(()=>!root.getElementById('library').hidden&&!root.getElementById('refreshLibrary').disabled);
  checks.push('选择录像与返回列表');
  result.textContent='通过：'+checks.join('；');
  await fetch('/artifact/cards-browser-results'+(query.has('narrow')?'-narrow':'')+(query.has('schedule-error')?'-fallback':'')+(query.has('slow-schedule')?'-race':'')+'.json',{method:'POST',body:JSON.stringify({passed:true,checks})});
 }catch(error){result.textContent='失败：'+error.message;}
}
