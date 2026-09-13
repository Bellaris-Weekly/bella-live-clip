import {MEMBERS} from '../domain/records.js';
import {formatDate, formatTime} from '../shared/format.js';
import {icon} from './icons.js';

export function createRecordCard(record, onSelect) {
 const card=document.createElement('button');card.className='record-card';
 const people=record.schedule?.participants||[];
 const color=MEMBERS.find(member=>member.room===Number(record.room))?.color||'#737373';
 card.style.setProperty('--card-color',color);card.style.setProperty('--card-tint',color+'0d');card.style.setProperty('--card-line',color+'40');
 card.setAttribute('aria-label',[formatDate(record.start),record.title,record.live?'直播中':null,record.schedule?.type,...people.map(p=>p.name),`时长 ${formatTime(record.end-record.start)}`].filter(Boolean).join(' · '));
 const heading=document.createElement('div');heading.className='card-heading';
 const parts=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(record.start*1000));
 const part=type=>parts.find(value=>value.type===type).value;
 const date=document.createElement('time');date.className='card-date';date.dateTime=new Date(record.start*1000).toISOString();date.setAttribute('aria-label',formatDate(record.start));
 const day=document.createElement('b');day.textContent=part('day');
 const dateInfo=document.createElement('span');const month=document.createElement('span');month.textContent=`${part('month')}月 · ${part('weekday')}`;
 const time=document.createElement('span');time.textContent=`${part('hour')}:${part('minute')}`;dateInfo.append(month,time);date.append(day,dateInfo);heading.append(date);
 if(record.schedule?.type){const tag=document.createElement('span');tag.className='record-type';tag.textContent=record.schedule.type;heading.append(tag);}
 const portraits=document.createElement('span');portraits.className='participants';
 for(const person of people){
  const portrait=document.createElement('span');portrait.className='participant';portrait.title=person.name;portrait.setAttribute('role','img');portrait.setAttribute('aria-label',person.name);portrait.style.setProperty('--member-color',person.color);
  portrait.innerHTML=icon('person');
  if(person.avatar){const img=document.createElement('img');img.src=person.avatar;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>img.remove();portrait.append(img);}
  portraits.append(portrait);
 }

 const title=document.createElement('strong');title.textContent=record.title;title.title=record.title;title.className='card-title';title.classList.toggle('hanging-title',/^[\p{Ps}\p{Pi}]/u.test(record.title));
 const details=document.createElement('div');details.className='card-details';
 const duration=document.createElement('span');duration.className='record-duration';duration.innerHTML=icon('clock');duration.append(document.createTextNode(record.live?'直播中':formatTime(record.end-record.start)));duration.title=record.live?'正在直播，最新录像可能有生成延迟':'实际场次时长';
 details.append(portraits,duration);card.append(heading,title,details);card.onclick=onSelect;
 return card;
}
