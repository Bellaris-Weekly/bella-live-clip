import {Component} from 'preact';
import {Icon} from './icon.jsx';

const MODES = [
  {mode: 'copy', label: '原画', title: '不重新编码，起止点对齐到关键帧'},
  {mode: 'precise', label: '精确', title: '按所选起止点裁剪，头尾重新编码'},
  {mode: 'danmaku', label: '弹幕', title: '按所选起止点裁剪，重新编码并压制弹幕（Beta）'},
];

// Media, stills and the timeline track are driven imperatively by the player and timeline
// controllers. They render once, so nothing here fights those controllers for the DOM.
class Frozen extends Component {
  shouldComponentUpdate() {
    return false;
  }
  render({children}) {
    return children;
  }
}
const Monitor = () => (
  <Frozen>
    <div id="playerWrap">
      <video id="fullVideo" tabIndex={0} playsInline preload="metadata" />
      <canvas id="pageMirror" hidden tabIndex={0} role="button" aria-label="B 站同步画面，点击播放或暂停" />
      <img id="videoStill" hidden alt="" />
      <div id="videoLoading">正在加载…</div>
      <button type="button" id="previewScreenshot" aria-label="截图" title="截图">
        <Icon name="camera" />
      </button>
    </div>
  </Frozen>
);
const Track = () => (
  <Frozen>
    <div
      id="timeline"
      tabIndex={0}
      aria-label="剪辑时间轴"
      title="方向键移动 5 秒，Shift＋方向键 1 秒，逗号和句号逐帧（视频为 0.1 秒）；空格播放，I / O 设为开始和结束；双击查看完整时间轴"
    >
      <div id="thumbnails" aria-hidden="true" />
      <div id="ticks" />
      <div id="selection" title="拖动平移选区，双击查看完整时间轴" />
      <div id="playhead" />
      <button type="button" id="startHandle" data-handle="start" role="slider" aria-label="选区起点" />
      <button type="button" id="endHandle" data-handle="end" role="slider" aria-label="选区终点" />
    </div>
  </Frozen>
);

function Transport({store, actions, locked, extras}) {
  const record = store.record.value,
    paused = store.paused.value,
    ready = store.ready.value,
    busy = store.busy.value;
  const submission = record?.kind === 'submission';
  const stepping = !submission && !busy && ready;
  return (
    <div class="transport">
      <button
        type="button"
        class="round primary"
        id="togglePlayback"
        aria-label={paused ? '播放' : '暂停'}
        title={paused ? '播放（空格）' : '暂停（空格）'}
        disabled={busy || !ready}
        onClick={actions.togglePlayback}
      >
        <Icon name={paused ? 'play' : 'pause'} />
      </button>
      {submission && (
        <button type="button" class="ghost small" disabled={busy || !ready} onClick={actions.playSelection}>
          <Icon name="loop" />
          播放选段
        </button>
      )}
      {!submission && (
        <div class="frame-step" role="group" aria-label="逐帧">
          <button
            type="button"
            class="icon small"
            aria-label="上一帧"
            title="上一帧（,）"
            disabled={!stepping}
            onClick={() => actions.stepFrame(-1)}
          >
            <Icon name="prevFrame" />
          </button>
          <button
            type="button"
            class="icon small"
            aria-label="下一帧"
            title="下一帧（.）"
            disabled={!stepping}
            onClick={() => actions.stepFrame(1)}
          >
            <Icon name="nextFrame" />
          </button>
        </div>
      )}
      <span class="spacer" />
      {extras?.composer && !submission && <extras.ui.CoverButton disabled={!stepping} onClick={actions.setCover} />}
      <button type="button" class="ghost small" id="markStart" disabled={locked} onClick={actions.markStart}>
        <Icon name="toStart" />
        设为开始<span class="kbd">I</span>
      </button>
      <button type="button" class="ghost small" id="markEnd" disabled={locked} onClick={actions.markEnd}>
        <Icon name="toEnd" />
        设为结束<span class="kbd">O</span>
      </button>
      <span id="clock" aria-label="当前播放时间与总时长">
        {store.clock.value}
      </span>
    </div>
  );
}

function Segments({store, actions, locked}) {
  const segments = store.segments.value;
  if (segments.length < 2) return null;
  return (
    <div id="segments" class="segments" role="group" aria-label="录像分段">
      {segments.map((segment, index) => (
        <button
          key={index}
          type="button"
          aria-pressed={String(index === store.segmentIndex.value)}
          disabled={locked}
          onClick={() => actions.selectSegment(index)}
        >
          第 {index + 1} 段<span>{segment.label}</span>
        </button>
      ))}
    </div>
  );
}

function TimelineCard({store, actions, locked, extras}) {
  const submission = store.record.value?.kind === 'submission',
    whole = store.whole.value;
  const typed = edge => event => actions.typeTime(edge, event.currentTarget.value);
  const enterBlurs = event => {
    if (event.key === 'Enter') event.currentTarget.blur();
    event.stopPropagation();
  };
  return (
    <section class="timeline-card" aria-label="剪辑时间轴">
      <div class="timeline-top">
        {!submission && (
          <label class="switch" id="wholeRecordingLabel">
            <input
              id="wholeRecording"
              type="checkbox"
              role="switch"
              checked={whole}
              disabled={store.busy.value || !store.ready.value}
              onChange={event => actions.setWhole(event.currentTarget.checked)}
            />
            整场
          </label>
        )}
        <span class="spacer" />
        <span id="timelineZoom" aria-label="时间轴倍率" title="滚轮缩放，双击查看完整时间轴">
          {store.zoom.value}
        </span>
      </div>
      {extras?.marks && <extras.ui.MarkPins marks={extras.marks} view={store.view} />}
      {extras?.composer && (
        <extras.ui.CoverPin composer={extras.composer} view={store.view} record={store.record.value} />
      )}
      <Track />
      <div class="timeline-footer">
        <div class="range" id="timelineLabels">
          <input
            id="selectionStart"
            aria-label="开始时间"
            title="输入开始时间，如 1:02:03"
            disabled={locked}
            onChange={typed('start')}
            onKeyDown={enterBlurs}
          />
          <span class="hint">—</span>
          <input
            id="selectionEnd"
            aria-label="结束时间"
            title="输入结束时间，如 1:02:30"
            disabled={locked}
            onChange={typed('end')}
            onKeyDown={enterBlurs}
          />
        </div>
        <span id="selectionDuration" aria-label="片段时长">
          {store.duration.value}
        </span>
      </div>
    </section>
  );
}

function Dock({store, actions, extras}) {
  const record = store.record.value,
    busy = store.busy.value,
    ready = store.ready.value,
    whole = store.whole.value,
    submission = record?.kind === 'submission';
  return (
    <div class="dock">
      {!whole && (
        <div id="exportMode" class="segmented" role="group" aria-label="导出方式">
          {MODES.filter(item => !(submission && item.mode === 'danmaku')).map(item => (
            <button
              key={item.mode}
              type="button"
              data-mode={item.mode}
              title={item.title}
              aria-pressed={String(store.exportMode.value === item.mode)}
              disabled={busy}
              onClick={() => actions.setExportMode(item.mode)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <span class="dock-info" id="estimatedSize">
        {store.estimate.value}
      </span>
      <div class="dock-actions" id="dockActions">
        <button
          type="button"
          class={extras?.composer && !submission ? '' : 'primary'}
          id="download"
          disabled={busy || !ready}
          onClick={actions.download}
        >
          <Icon name="download" />
          {whole ? '导出整场' : '导出'}
        </button>
        {extras?.composer && !submission && !whole && <ComposeButton composer={extras.composer} />}
      </div>
    </div>
  );
}

function ComposeButton({composer}) {
  const view = composer.view.value;
  // A submission keeps running while you cut; the button shows how far it is and brings it back.
  const running = !view.open && view.cancellable && view.selection && !view.bvid;
  return (
    <button
      type="button"
      class="primary"
      id="studioSubmit"
      disabled={!running && !view.canStart}
      onClick={composer.actions.start}
    >
      <Icon name="upload" />
      {running ? `投稿中 · ${view.progress}` : '投稿'}
    </button>
  );
}

// Internal build only: its components arrive through `extras`, so the public build never bundles them.
function Side({extras}) {
  const {MarksPanel} = extras.ui;
  return (
    <aside id="editorSide" class="card side" aria-label="本场轴">
      {extras.marks && (
        <div class="side-pane">
          <MarksPanel marks={extras.marks} onCompose={extras.composeMark} />
        </div>
      )}
    </aside>
  );
}

// Two steps: cut (player, timeline, marks), then submit, which takes the whole area.
// The editor stays mounted underneath so going back is instant.
export function Editor({store, actions}) {
  const locked = store.busy.value || !store.ready.value || store.whole.value;
  const extras = store.extras.value;
  const props = {store, actions, locked, extras};
  const composing = Boolean(extras?.composer?.view.value.open);
  const ComposeSheet = extras?.ui.ComposeSheet;
  return (
    <section id="editPage" tabIndex={-1} hidden={store.page.value !== 'edit'} aria-label="剪辑">
      <div class={`editor${extras ? ' has-side' : ''}`} hidden={composing}>
        <div class="editor-main">
          <div class="stage">
            <Monitor />
            <Transport {...props} />
            <Segments {...props} />
            <TimelineCard {...props} />
          </div>
          <Dock store={store} actions={actions} extras={extras} />
        </div>
        {extras && <Side extras={extras} />}
      </div>
      {ComposeSheet && <ComposeSheet composer={extras.composer} />}
    </section>
  );
}
