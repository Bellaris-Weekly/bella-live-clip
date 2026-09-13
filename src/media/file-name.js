import {formatTime} from '../shared/format.js';

export function fileName(record, start, end, part = '') {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(record.start * 1000));
  const label = `${record.member}_${date}_${record.title}_${formatTime(start).replaceAll(':', '-')}-${formatTime(end).replaceAll(':', '-')}${part}`;
  return label.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) + '.mp4';
}
