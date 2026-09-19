// B站 videoshot sheets contain a grid of preview stills, not playable media.
export function storyboardCell(data,time) {
 const {img_x_len:columns,img_y_len:rows,img_x_size:width,img_y_size:height,image,index}=data;
 if(![columns,rows,width,height].every(value=>Number.isInteger(value)&&value>0)||!Array.isArray(index)||!index.length||!Array.isArray(image)||!image.length)throw new Error('这个视频暂无进度预览图。');
 // The index generated from pvdata may retain its leading zero word before
 // the first zero-second image. Do not count that word as an extra cell.
 const offset=index[0]===0&&index[1]===0?1:0;
 let low=offset,high=index.length;
 while(low<high){const middle=(low+high)>>1;if(index[middle]<=time)low=middle+1;else high=middle;}
 const position=Math.max(0,low-1-offset),sheet=Math.floor(position/(columns*rows));
 if(!image[sheet])throw new Error('当前位置暂无进度预览图。');
 const url=new URL(image[sheet],'https://www.bilibili.com');
 if(url.protocol!=='https:'||!(url.hostname==='hdslb.com'||url.hostname.endsWith('.hdslb.com')))throw new Error('预览图地址不受支持。');
 return {url:url.href,x:position%columns*width,y:Math.floor(position%(columns*rows)/columns)*height,width,height,columns,rows};
}

export function createSubmissionStoryboard({metadataRequest,mediaRequest,submission,decode=blob=>createImageBitmap(blob)}) {
 const lifetime=new AbortController(),sheets=new Map();
 let metadata=null;
 // Pointer moves cancel only their own wait. Metadata and sheets belong to the
 // loaded video, so the next position can reuse an in-flight download.
 async function wait(pending,signal){
  signal.throwIfAborted();let abort;
  try{
   const result=await Promise.race([pending,new Promise((_,reject)=>{
    abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
   })]);
   signal.throwIfAborted();lifetime.signal.throwIfAborted();return result;
  }finally{signal.removeEventListener('abort',abort);}
 }
 function getMetadata(){
  if(!metadata)metadata=(async()=>{
   const params=new URLSearchParams({bvid:submission.bvid,cid:submission.cid,index:1});
   const {data}=await metadataRequest(`https://api.bilibili.com/x/player/videoshot?${params}`,{auth:true,signal:lifetime.signal,referer:submission.referer});
   lifetime.signal.throwIfAborted();const result=JSON.parse(data);
   if(result.code!==0||!result.data)throw new Error('这个视频暂无进度预览图。');
   return result.data;
  })().catch(error=>{metadata=null;throw error;});
  return metadata;
 }
 function release(entry){entry.controller.abort();entry.image?.close();}
 function getSheet(url){
  let entry=sheets.get(url);
  if(entry){sheets.delete(url);sheets.set(url,entry);return entry.pending;}
  entry={controller:new AbortController(),image:null,pending:null};sheets.set(url,entry);
  // Keep both sides of a sheet boundary, including pending downloads. Eviction
  // bounds network work and decoded memory even when scrubbing a long video.
  if(sheets.size>2){const oldest=sheets.keys().next().value;release(sheets.get(oldest));sheets.delete(oldest);}
  const {signal}=entry.controller;
  entry.pending=(async()=>{
   const {data}=await mediaRequest(url,{type:'arraybuffer',signal,referer:submission.referer});
   signal.throwIfAborted();const image=await decode(new Blob([data]));
   if(signal.aborted){image.close();signal.throwIfAborted();}
   entry.image=image;return image;
  })().catch(error=>{if(sheets.get(url)===entry)sheets.delete(url);throw error;});
  return entry.pending;
 }
 return {
  async read(time,signal){
   signal.throwIfAborted();lifetime.signal.throwIfAborted();
   const cell=storyboardCell(await wait(getMetadata(),signal),time);
   const image=await wait(getSheet(cell.url),signal);
   // Some CDN image variants scale the whole sheet; crop by the actual grid.
   const width=image.width/cell.columns,height=image.height/cell.rows;
   return {image,x:cell.x/cell.width*width,y:cell.y/cell.height*height,width,height};
  },
  dispose(){lifetime.abort();for(const entry of sheets.values())release(entry);sheets.clear();},
 };
}
