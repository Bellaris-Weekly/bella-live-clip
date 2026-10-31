import {formatTime} from '../shared/format.js';

// eslint-disable-next-line no-control-regex -- control characters are exactly what must go
const UNSAFE_NAME = /[\u0000-\u001f<>:"/\\|?*]/g;

export function fileName(record, start, end, part = '') {
  if (record.kind === 'submission') {
    const label = `${record.title}${record.partTitle ? `_P${record.part}_${record.partTitle}` : ''}_${formatTime(start).replaceAll(':', '-')}-${formatTime(end).replaceAll(':', '-')}${part}`;
    return cleanName(label);
  }
  const date = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(new Date(record.start * 1000));
  const label = `${record.member}_${date}_${record.title}_${formatTime(start).replaceAll(':', '-')}-${formatTime(end).replaceAll(':', '-')}${part}`;
  return cleanName(label);
}

const cleanName = label =>
  label
    .replace(UNSAFE_NAME, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180) + '.mp4';
