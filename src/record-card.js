import {formatDate, formatTime} from './core.js';
import {icon} from './icons.js';

export function createRecordCard(record, onSelect) {
 const card=document.createElement('button');card.className='record-card';
 const people=record.schedule?.participants||[];
 card.setAttribute('aria-label',[formatDate(record.start),record.title,record.schedule?.type,...people.map(p=>p.name),`时长 ${formatTime(record.end-record.start)}`].filter(Boolean).join(' · '));
 const heading=document.createElement('div');heading.className='card-heading';
 if(record.schedule?.type){const tag=document.createElement('span');tag.className='record-type';tag.textContent=record.schedule.type;heading.append(tag);}
 const portraits=document.createElement('span');portraits.className='participants';
 for(const person of people){
  const portrait=document.createElement('span');portrait.className='participant';portrait.title=person.name;portrait.setAttribute('role','img');portrait.setAttribute('aria-label',person.name);portrait.style.setProperty('--member-color',person.color);
  portrait.innerHTML=icon('person');
  if(person.avatar){const img=document.createElement('img');img.src=person.avatar;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>img.remove();portrait.append(img);}
  portraits.append(portrait);
 }
 heading.append(portraits);
 const title=document.createElement('strong');title.textContent=record.title;title.title=record.title;title.className='card-title';title.classList.toggle('hanging-title',/^[\p{Ps}\p{Pi}]/u.test(record.title));
 const details=document.createElement('div');details.className='card-details';
 const date=document.createElement('time');date.dateTime=new Date(record.start*1000).toISOString();date.textContent=formatDate(record.start);
 const duration=document.createElement('span');duration.className='record-duration';duration.innerHTML=icon('clock');duration.append(document.createTextNode(formatTime(record.end-record.start)));duration.title='实际场次时长';
 details.append(date,duration);card.append(heading,title,details);card.onclick=onSelect;
 return card;
}
