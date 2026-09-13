// Static controls are discovered once; cards are created when the list changes.
export function createControls(root,timeline){
  const $=id=>root.getElementById(id);
  const marks=[$('markStart'),$('markEnd')];
  const editor=[$('togglePlayback'),$('wholeRecording'),$('download')];
  const managed=new Set([...marks,...editor,$('cancel'),$('startHandle'),$('endHandle')]);
  const navigation=[...root.querySelectorAll('#body button,#body input')].filter(el=>!managed.has(el));
  const cards=$('cards'),download=$('download'),label=download.querySelector('span');
  const exportMode=$('exportMode'),cancel=$('cancel'),progress=$('progress'),launcher=$('launcher');
  let locked;
  const assign=(element,key,value)=>{if(element[key]!==value)element[key]=value;};
  return ({busy,ready,page,whole})=>{
    for(const element of [...navigation,...cards.children])assign(element,'disabled',busy);
    for(const element of editor)assign(element,'disabled',busy||!ready);
    for(const element of marks)assign(element,'disabled',busy||!ready||whole);
    const nextLocked=busy||!ready||whole;
    if(locked!==nextLocked){locked=nextLocked;timeline.lock(locked);}
    assign(exportMode,'hidden',whole);
    assign(label,'textContent',whole?'导出整场':'导出');
    assign(download,'hidden',page!=='edit');
    assign(cancel,'hidden',!busy);assign(progress,'hidden',!busy);
    assign(launcher.dataset,'busy',String(busy));
  };
}
