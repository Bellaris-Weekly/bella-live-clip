import {useEffect, useLayoutEffect, useRef, useState} from 'preact/hooks';
import {Icon} from './icon.jsx';
import {WindowResizeHandles} from './window-resize-handles.jsx';
import {markTime} from '../preview/marks.js';
import {AUTOSAVE_SECONDS} from '../preview/marks-session.js';

const FILTERS = [
  ['all', '全部', () => true],
  ['open', '未投稿', mark => !mark.bvid && !mark.deleted],
  ['done', '已投稿', mark => Boolean(mark.bvid)],
  ['mine', '我的', mark => mark.mine],
];
const OPS = {create: '新建', update: '修改', delete: '删除', restore: '恢复'};
const FIELDS = {room_id: '直播间', at: '时间', note: '备注', bvid: 'BV 号', deleted: '删除状态'};
const BV = /^BV[0-9A-Za-z]+$/;

function describe(key, value) {
  if (value === null || value === undefined) return '无';
  if (key === 'at' && typeof value === 'number') return markTime(value);
  if (typeof value === 'boolean') return value ? '已删除' : '未删除';
  return String(value);
}

function MarkState({mark}) {
  // Uploads are silent; only an upload that has already failed once is shown.
  if (mark.pending)
    return mark.error ? (
      <span class="badge wait" title={mark.error}>
        未同步
      </span>
    ) : null;
  if (mark.deleted) return <span class="badge bad">已删除</span>;
  if (BV.test(mark.bvid || ''))
    return (
      <a class="bv mono" href={`https://www.bilibili.com/video/${mark.bvid}`} target="_blank" rel="noopener noreferrer">
        {mark.bvid}
      </a>
    );
  if (mark.waiting) return <span class="badge wait">等待回放</span>;
  return null;
}

function EditRow({mark, actions}) {
  const [time, setTime] = useState(markTime(mark.at));
  const [note, setNote] = useState(mark.note || '');
  const first = useRef(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <form
      class="mark-edit"
      onSubmit={event => {
        event.preventDefault();
        void actions.save(mark, time, note);
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') actions.cancelEdit();
      }}
    >
      <input
        ref={first}
        class="mono"
        aria-label="轴时间（东八区）"
        value={time}
        onInput={e => setTime(e.currentTarget.value)}
      />
      <input aria-label="轴备注" maxLength={200} value={note} onInput={e => setNote(e.currentTarget.value)} />
      <div class="mark-edit-actions">
        <button type="button" class="small ghost" onClick={actions.cancelEdit}>
          取消
        </button>
        <button class="small tonal">保存</button>
      </div>
    </form>
  );
}

function MarkRow({mark, selected, actions, onCompose}) {
  const [menu, setMenu] = useState(false);
  const canJump = mark.time !== null && !mark.deleted;
  return (
    <li
      class={`mark-row${selected ? ' is-selected' : ''}${mark.deleted ? ' is-deleted' : ''}`}
      onMouseLeave={() => setMenu(false)}
    >
      <button
        type="button"
        class="mark-main"
        disabled={mark.deleted}
        title={canJump ? '跳到这条轴并选中前后片段' : undefined}
        onClick={() => actions.jump(mark)}
      >
        <span class="mark-time mono">{markTime(mark.at)}</span>
        <span class={`mark-note${mark.note ? '' : ' is-empty'}`}>{mark.note || '无备注'}</span>
        {!mark.mine && <span class="mark-who">{mark.created_by}</span>}
      </button>
      <span class="mark-side">
        <MarkState mark={mark} />
        {onCompose && !mark.deleted && !mark.pending && !mark.bvid && (
          <button type="button" class="small tonal mark-compose" onClick={() => onCompose(mark)}>
            <Icon name="upload" />
            投稿
          </button>
        )}
        {!mark.pending && (
          <span class="menu-anchor">
            <button
              type="button"
              class="icon small"
              aria-label="更多操作"
              aria-expanded={String(menu)}
              onClick={() => setMenu(!menu)}
            >
              <Icon name="more" />
            </button>
            {menu && (
              <span class="menu" role="menu" onClick={() => setMenu(false)}>
                {!mark.deleted && (
                  <button type="button" role="menuitem" onClick={() => actions.edit(mark)}>
                    编辑
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => (mark.deleted ? actions.restore(mark) : actions.remove(mark))}
                >
                  {mark.deleted ? '撤销删除' : '删除'}
                </button>
                <button type="button" role="menuitem" onClick={() => actions.history(mark)}>
                  变更历史
                </button>
              </span>
            )}
          </span>
        )}
      </span>
    </li>
  );
}

// The draft of a mark just taken: the time can still be moved before the note is saved.
function CaptureRow({capture, actions}) {
  const input = useRef(null);
  useEffect(() => input.current?.focus({preventScroll: true}), [capture.id]);
  return (
    <div class="capture" role="group" aria-label="刚记的轴">
      <div class="capture-time">
        <b class="mono">{markTime(capture.at)}</b>
        <button type="button" class="small ghost" title="时间往前 5 秒" onClick={() => actions.shiftCapture(-5)}>
          −5s
        </button>
        <button type="button" class="small ghost" title="时间往后 5 秒" onClick={() => actions.shiftCapture(5)}>
          +5s
        </button>
        <button type="button" class="small ghost" title="改成当前时间" onClick={actions.restamp}>
          现在
        </button>
        <span class="spacer" />
        <button type="button" class="icon small" aria-label="放弃这条轴" title="放弃" onClick={actions.discardCapture}>
          <Icon name="close" />
        </button>
      </div>
      <form
        class="capture-note"
        onSubmit={event => {
          event.preventDefault();
          actions.saveCapture();
        }}
      >
        <input
          ref={input}
          maxLength={200}
          aria-label="轴备注"
          placeholder="备注，Enter 保存"
          value={capture.note}
          onInput={event => actions.setNote(event.currentTarget.value)}
          onFocus={actions.holdCapture}
          onBlur={actions.releaseCapture}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Escape') actions.discardCapture();
          }}
        />
        <button class="small tonal">保存</button>
      </form>
      {capture.deadline && (
        <div class="meter capture-timer" title={`${AUTOSAVE_SECONDS} 秒后自动保存`}>
          <span key={capture.deadline} style={{animationDuration: `${AUTOSAVE_SECONDS}s`}} />
        </div>
      )}
    </div>
  );
}

function History({history, actions}) {
  const dialog = useRef(null);
  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);
  return (
    <dialog ref={dialog} class="history" aria-label="轴的变更历史" onClose={actions.closeHistory}>
      <div class="sheet-head">
        <h2>变更历史 · {markTime(history.mark.at)}</h2>
        <button type="button" class="icon" aria-label="关闭" onClick={actions.closeHistory}>
          <Icon name="close" />
        </button>
      </div>
      {!history.rows ? (
        <p class="empty">正在加载…</p>
      ) : (
        <ol class="history-list">
          {history.rows.map(row => (
            <li key={row.rev}>
              <strong>
                版本 {row.rev} · {OPS[row.op] || row.op} · {row.by}
              </strong>
              <span class="hint">{new Date(row.at_time).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}</span>
              {Object.entries(row.changes || {}).map(([key, change]) => (
                <p key={key}>
                  {FIELDS[key] || key}：{describe(key, change[0])} → {describe(key, change[1])}
                </p>
              ))}
            </li>
          ))}
        </ol>
      )}
    </dialog>
  );
}

function MarkList({marks, selectedId, editingId, actions, onCompose}) {
  if (!marks.length) return <p class="empty mark-empty">这里还没有轴。直播时按快捷键记一条，或在上方补记。</p>;
  return (
    <ul class="mark-list">
      {marks.map(mark =>
        editingId === mark.id ? (
          <li key={mark.id} class="mark-row is-editing">
            <EditRow mark={mark} actions={actions} />
          </li>
        ) : (
          <MarkRow
            key={mark.id}
            mark={mark}
            selected={selectedId === mark.id}
            actions={actions}
            onCompose={onCompose}
          />
        ),
      )}
    </ul>
  );
}

export function MarksPanel({marks: session, onCompose}) {
  const {state, actions} = session;
  const [text, setText] = useState('');
  const items = state.items.value,
    filter = state.filter.value,
    capture = state.capture.value;
  const shown = items.filter(FILTERS.find(([id]) => id === filter)[2]);
  return (
    <>
      <div class="side-head">
        <h2>本场轴</h2>
        <span class="count">{items.filter(mark => !mark.deleted).length}</span>
        <span class="spacer" />
        <button
          type="button"
          class="icon small"
          aria-label="刷新轴表"
          title="刷新轴表"
          onClick={() => session.refresh(true)}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {capture && <CaptureRow capture={capture} actions={actions} />}
      <form
        class="mark-add"
        onSubmit={async event => {
          event.preventDefault();
          if (!text.trim()) return actions.capture();
          await actions.add(text);
          setText('');
        }}
      >
        <input
          id="manualMark"
          aria-label="补记时间和备注"
          placeholder="补记：21:13:40 跑调"
          maxLength={210}
          value={text}
          onInput={event => setText(event.currentTarget.value)}
          onKeyDown={event => event.stopPropagation()}
        />
        <button class="tonal" title={text.trim() ? '补记这条轴' : '按当前时间记一条轴'}>
          <Icon name="flag" />
          {text.trim() ? '补记' : '记轴'}
        </button>
      </form>
      <div class="filters" role="group" aria-label="筛选">
        {FILTERS.map(([id, label, test]) => (
          <button key={id} type="button" aria-pressed={String(filter === id)} onClick={() => actions.setFilter(id)}>
            {label} {items.filter(test).length}
          </button>
        ))}
      </div>
      {state.error.value && <p class="inline-error mark-error">{state.error.value}</p>}
      <div class="side-body">
        <MarkList
          marks={shown}
          selectedId={state.selected.value}
          editingId={state.editing.value}
          actions={actions}
          onCompose={onCompose}
        />
      </div>
      <div class="side-foot">
        <span class="kbd">{state.shortcut.value}</span>随时记轴
      </div>
      {state.history.value && <History history={state.history.value} actions={actions} />}
    </>
  );
}

// Pins above the timeline, positioned in the timeline's current view.
export function MarkPins({marks: session, view}) {
  const {start, end} = view.value;
  const selected = session.state.selected.value;
  const pins = session.state.items.value.filter(mark => mark.time !== null && mark.time >= start && mark.time <= end);
  return (
    <div class="mark-pins" aria-label="轴位置">
      {pins.map(mark => (
        <button
          key={mark.id}
          type="button"
          class={`pin${mark.id === selected ? ' is-selected' : ''}${mark.bvid ? ' is-done' : ''}`}
          style={{left: `${((mark.time - start) / (end - start)) * 100}%`}}
          title={`${markTime(mark.at)} ${mark.note || ''}`}
          aria-label={`跳到 ${markTime(mark.at)} ${mark.note || ''}`}
          onClick={() => session.actions.jump(mark)}
        />
      ))}
    </div>
  );
}

// Live pages: a small window that leaves the stream visible.
export function MiniMarks({marks: session, onExpand, bindWindow}) {
  const {state, actions} = session;
  const element = useRef(null);
  const visible = state.mini.value;
  useLayoutEffect(() => (visible ? bindWindow?.(element.current) : undefined), [visible, bindWindow]);
  if (!visible) return null;
  const live = state.live.value,
    capture = state.capture.value;
  const kept = state.items.value.filter(mark => !mark.deleted);
  const recent = kept.slice(-4).reverse();
  return (
    <section id="miniMarks" ref={element} aria-label="记轴小窗">
      <div class="mini-head">
        <span class="live-title">
          {live ? <i class="live-dot" /> : null}
          <span>
            {live ? `${live.member || ''}直播中` : '记轴'} · {kept.length} 条
          </span>
        </span>
        <button type="button" class="icon small" aria-label="展开剪辑" title="展开剪辑" onClick={onExpand}>
          <Icon name="expand" />
        </button>
        <button type="button" class="icon small" aria-label="收起小窗" title="收起小窗" onClick={actions.hideMini}>
          <Icon name="minus" />
        </button>
      </div>
      <div class="mini-capture">
        <button type="button" class="primary" onClick={actions.capture}>
          <Icon name="flag" />
          <span class="spacer">记轴</span>
          <span class="kbd">{state.shortcut.value}</span>
        </button>
      </div>
      <div class="mini-body">
        {capture && <CaptureRow capture={capture} actions={actions} />}
        {/* Without the editor there is nothing to jump to; a tap edits the note instead. */}
        <MarkList marks={recent} editingId={state.editing.value} actions={{...actions, jump: actions.edit}} />
        {state.error.value && <p class="inline-error mark-error">{state.error.value}</p>}
        {state.history.value && <History history={state.history.value} actions={actions} />}
      </div>
      <WindowResizeHandles />
    </section>
  );
}
