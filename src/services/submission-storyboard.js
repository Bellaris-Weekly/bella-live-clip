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
 let metadata=null,image=null,imageUrl=null,closed=false;
 return {
  async read(time,signal){
   signal.throwIfAborted();
   if(!metadata){
    const params=new URLSearchParams({bvid:submission.bvid,cid:submission.cid,index:1});
    const {data}=await metadataRequest(`https://api.bilibili.com/x/player/videoshot?${params}`,{auth:true,signal,referer:submission.referer});
    signal.throwIfAborted();const result=JSON.parse(data);
    if(result.code!==0||!result.data)throw new Error('这个视频暂无进度预览图。');
    metadata=result.data;
   }
   const cell=storyboardCell(metadata,time);
   if(imageUrl!==cell.url){
    const {data}=await mediaRequest(cell.url,{type:'arraybuffer',signal,referer:submission.referer});
    signal.throwIfAborted();const next=await decode(new Blob([data]));
    if(signal.aborted||closed){next.close();signal.throwIfAborted();throw new DOMException('Preview closed','AbortError');}
    image?.close();image=next;imageUrl=cell.url;
   }
   // Some CDN image variants scale the whole sheet; crop by the actual grid.
   const width=image.width/cell.columns,height=image.height/cell.rows;
   return {image,x:cell.x/cell.width*width,y:cell.y/cell.height*height,width,height};
  },
  dispose(){closed=true;image?.close();image=null;imageUrl=null;},
 };
}
