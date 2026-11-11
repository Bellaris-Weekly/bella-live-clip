import {Icon} from './icon.jsx';
import {MEMBERS} from '../domain/records.js';
import {formatDate, formatTime} from '../shared/format.js';

const DATE_PARTS = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function RecordRow({record, disabled, onOpen}) {
  const parts = Object.fromEntries(
    DATE_PARTS.formatToParts(new Date(record.start * 1000)).map(part => [part.type, part.value]),
  );
  const people = record.schedule?.participants || [];
  const color = MEMBERS.find(member => member.room === Number(record.room))?.color;
  const length = record.live ? '直播中' : formatTime(record.end - record.start);
  return (
    <button
      type="button"
      class={`record${record.live ? ' is-live' : ''}`}
      style={color ? {'--member': color} : undefined}
      data-record-key={record.key}
      disabled={disabled}
      onClick={onOpen}
      aria-label={[formatDate(record.start), record.title, record.schedule?.type, ...people.map(p => p.name), length]
        .filter(Boolean)
        .join(' · ')}
    >
      <time class="record-date" dateTime={new Date(record.start * 1000).toISOString()}>
        <b>{parts.day}</b>
        <small>{parts.month}月</small>
      </time>
      <span class="record-main">
        <span class="record-title" title={record.title}>
          {record.title}
        </span>
        <span class="record-meta">
          {record.live && <i class="live-dot" />}
          <span>
            {parts.weekday} {parts.hour}:{parts.minute}
          </span>
          <span>{length}</span>
          {record.schedule?.type && <span class="badge">{record.schedule.type}</span>}
          {people.length > 0 && (
            <span class="people">
              {people.map(person => (
                <span
                  key={person.name}
                  class="person"
                  title={person.name}
                  role="img"
                  aria-label={person.name}
                  style={{'--member-color': person.color}}
                >
                  <Icon name="person" />
                  {person.avatar && (
                    <img
                      src={person.avatar}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={event => event.currentTarget.remove()}
                    />
                  )}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

// Shown only on a first load, before any list (fresh or saved) exists.
const PLACEHOLDERS = Array.from({length: 8}, (_, index) => (
  <div key={index} class="record is-placeholder" aria-hidden="true">
    <span class="record-date" />
    <span class="record-main">
      <span class="record-title" />
      <span class="record-meta" />
    </span>
  </div>
));

export function Library({store, actions, members}) {
  const busy = store.busy.value,
    current = store.member.value,
    records = store.records.value,
    loaded = store.libraryLoaded.value;
  return (
    <section id="library" class="library" hidden={store.page.value !== 'library'}>
      <div class="library-tools">
        <div class="members" role="group" aria-label="成员">
          {members.map(member => (
            <button
              key={member.id}
              type="button"
              data-member={member.id}
              aria-pressed={String(member.id === current.id)}
              disabled={busy}
              onClick={() => actions.selectMember(member)}
            >
              <i class="dot" style={{background: member.color}} />
              {member.name}
            </button>
          ))}
        </div>
        <span class="spacer" />
        <button
          type="button"
          class="icon"
          id="refreshLibrary"
          aria-label="刷新场次"
          title="刷新场次"
          disabled={busy}
          onClick={actions.refreshLibrary}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {store.currentVideo.value && (
        <div class="current-video">
          <p>当前页面是一个 B 站视频</p>
          <button type="button" class="primary" id="currentVideo" disabled={busy} onClick={actions.currentVideo}>
            剪辑当前视频
            <Icon name="chevron" />
          </button>
        </div>
      )}
      {store.libraryNote.value && (
        <p class="notice" role="status">
          {store.libraryNote.value}
        </p>
      )}
      <div class="records" aria-busy={loaded ? undefined : 'true'}>
        {records.map(record => (
          <RecordRow key={record.key} record={record} disabled={busy} onOpen={() => actions.openRecord(record)} />
        ))}
        {!loaded && !records.length && PLACEHOLDERS}
      </div>
      {loaded && !records.length && <p class="empty">近 14 天暂无可用回放</p>}
    </section>
  );
}
