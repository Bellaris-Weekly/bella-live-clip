import {Icon} from './icon.jsx';
import {MEMBERS, hasSchedule} from '../domain/records.js';
import {librarySessions} from '../domain/sessions.js';
import {formatDate, formatLength} from '../shared/format.js';

const DATE_PARTS = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const dateParts = seconds =>
  Object.fromEntries(DATE_PARTS.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
const lengthText = record => (record.live ? '直播中' : formatLength(record.end - record.start));

function RecordingParts({session, disabled, onOpen}) {
  return (
    <div class="recording-parts" role="group" aria-label="多段录像">
      <span class="recording-parts-label">多段录像：</span>
      {session.parts.map(part => {
        const {hour, minute} = dateParts(part.start);
        return (
          <button
            key={part.key}
            type="button"
            class={`recording-part${part === session.main ? ' is-main' : ''}`}
            disabled={disabled}
            onClick={() => onOpen(part)}
          >
            {hour}:{minute} · {lengthText(part)}
          </button>
        );
      })}
    </div>
  );
}

function RecordRow({session, disabled, onOpen}) {
  const record = session.main;
  const parts = dateParts(session.start);
  const people = record.schedule?.participants || [];
  const length = record.live ? '直播中' : formatLength(session.length);
  return (
    <button
      type="button"
      class="record"
      data-record-key={record.key}
      disabled={disabled}
      onClick={() => onOpen(record)}
      aria-label={[formatDate(session.start), record.title, record.schedule?.type, ...people.map(p => p.name), length]
        .filter(Boolean)
        .join(' · ')}
    >
      <time class="record-date" dateTime={new Date(session.start * 1000).toISOString()}>
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
        </span>
      </span>
      {hasSchedule(record.room) && (
        <span class="record-side">
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
          {record.schedule?.type && <span class="badge">{record.schedule.type}</span>}
        </span>
      )}
    </button>
  );
}

function SessionCard({session, disabled, onOpen}) {
  const member = MEMBERS.find(item => item.room === Number(session.main.room));
  return (
    <div
      class={`record-card${session.main.live ? ' is-live' : ''}`}
      style={member && {'--member': member.color, '--member-dark': member.darkColor || member.color}}
    >
      <RecordRow session={session} disabled={disabled} onOpen={onOpen} />
      {session.parts.length > 1 && <RecordingParts session={session} disabled={disabled} onOpen={onOpen} />}
    </div>
  );
}

// Shown only on a first load, before any list (fresh or saved) exists.
const PLACEHOLDERS = Array.from({length: 8}, (_, index) => (
  <div key={index} class="record-card is-placeholder" aria-hidden="true">
    <div class="record">
      <span class="record-date" />
      <span class="record-main">
        <span class="record-title" />
        <span class="record-meta" />
      </span>
    </div>
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
        {librarySessions(records).map(session => (
          <SessionCard key={session.parts[0].key} session={session} disabled={busy} onOpen={actions.openRecord} />
        ))}
        {!loaded && !records.length && PLACEHOLDERS}
      </div>
      {loaded && !records.length && <p class="empty">近 14 天暂无可用回放</p>}
    </section>
  );
}
