import {parsePlaylist} from './hls.js';

// One instance belongs to one loaded recording. Refreshing creates a new instance.
export class RecordingPlan {
  constructor(api,streams,signal){this.api=api;this.streams=streams;this.signal=signal;this.pending=null;}

  async read(){
    const groups=[];
    for(const stream of this.streams){
      const response=await this.api.request(stream.stream,{signal:this.signal});
      this.signal?.throwIfAborted();
      const parsed=parsePlaylist(response.data,response.url);
      for(const group of parsed.groups)groups.push({...group,start:stream.start_time+group.offset,streamEnd:stream.end_time});
    }
    return groups;
  }

  async load(signal){
    this.signal?.throwIfAborted();signal?.throwIfAborted();
    this.pending??=this.read().catch(error=>{this.pending=null;throw error;});
    if(!signal)return this.pending;
    // Cancel this caller's wait without canceling another consumer's shared read.
    let abort;
    try{
      return await Promise.race([this.pending,new Promise((_,reject)=>{
        abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
      })]);
    }finally{signal.removeEventListener('abort',abort);}
  }
}
