export function formatTime(seconds, fractional = false) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${fractional ? '.' + String(ms % 1000).padStart(3, '0') : ''}`;
}

// Accepts 1:02:03.5, 02:03 or plain seconds; anything else is null.
export function parseTime(text) {
  const match = /^(?:(?:(\d+):)?(\d+):)?(\d+(?:\.\d+)?)$/.exec(text.trim().replace('：', ':'));
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3]);
}

export function formatTimeRange(start,end,separator=' — ') {
  const values=[start,end].map(value=>Math.floor(Math.max(0,value)));
  const hours=values.map(value=>Math.floor(value/3600));
  const showHours=hours.some(value=>value>0);
  const hourWidth=Math.max(2,...hours.map(value=>String(value).length));
  return values.map((value,i)=>{
    const minutes=String(Math.floor(value/60)%60).padStart(2,'0');
    const seconds=String(value%60).padStart(2,'0');
    return `${showHours?String(hours[i]).padStart(hourWidth,'0')+':':''}${minutes}:${seconds}`;
  }).join(separator);
}

export function formatDuration(seconds) {
  const tenths=Math.round(Math.max(0,seconds)*10);
  const h=Math.floor(tenths/36000),m=Math.floor(tenths/600)%60,s=(tenths%600)/10;
  return `${h ? h+'时' : ''}${h||m ? m+'分' : ''}${s.toFixed(1)}秒`;
}

export function formatDate(unix, withSeconds = false) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  }).format(new Date(unix * 1000));
}

export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
