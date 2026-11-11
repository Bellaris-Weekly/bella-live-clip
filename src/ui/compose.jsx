import {Component} from 'preact';
import {Icon} from './icon.jsx';
import {CoverEditor} from './cover.jsx';
import {markTime} from '../preview/marks.js';
import {formatTime} from '../shared/format.js';

// The template form builds its own fields; it renders once and keeps them.
class Host extends Component {
  shouldComponentUpdate() {
    return false;
  }
  render({id, class: className}) {
    return <div id={id} class={className} />;
  }
}

function Progress({label, value, name}) {
  const percent = Math.round(value * 100);
  return (
    <div class="compose-progress">
      <span>{label}</span>
      <div class="meter" role="progressbar" aria-label={label} aria-valuenow={percent} data-progress={name}>
        <span style={{width: `${percent}%`}} />
      </div>
      <b class="mono">{percent}%</b>
    </div>
  );
}

// The second step after cutting: the whole editor area goes to the cover and the form.
// The form host exists before the composer does: it builds its fields into it.
export function ComposeSheet({composer}) {
  const view = composer?.view.value || {open: false},
    actions = composer?.actions || {};
  return (
    <form
      class="compose"
      hidden={!view.open}
      aria-label="投稿"
      onSubmit={event => {
        event.preventDefault();
        actions.confirm();
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      <div class="compose-head">
        <button type="button" class="ghost small" data-back onClick={actions.close}>
          <Icon name="back" />
          返回剪辑
        </button>
        <div class="compose-title">
          <h2>投稿</h2>
          <p class="hint" data-selection>
            {view.title && <span class="compose-record">{view.title}</span>}
            {view.selection}
          </p>
        </div>
      </div>
      {/* Keyed: without them the grid could take the banner's place and rebuild the form host empty. */}
      {view.stale ? (
        <div key="stale" class="compose-stale" role="alert" data-stale>
          <p>
            剪辑里的选段已改为 <b>{view.stale}</b>，正在导出的仍是原来那段。
          </p>
          <button type="button" class="primary small" data-restart onClick={actions.restart}>
            改投新选段
          </button>
          <button type="button" class="ghost small" onClick={actions.keep}>
            继续投原来那段
          </button>
        </div>
      ) : null}
      <div key="grid" class="compose-grid">
        <section class="compose-cover" aria-label="封面">
          {composer && <CoverEditor cover={composer.cover} disabled={view.locked} />}
        </section>
        <section class="compose-side">
          <div class="compose-body">
            {view.mark && (
              <div class="linked" data-mark>
                <span class="mono">{markTime(view.mark.at)}</span>
                <span class="linked-note">{view.mark.note || '未写备注'}</span>
                <button type="button" class="link small" disabled={view.markLocked} onClick={actions.unlinkMark}>
                  解除关联
                </button>
              </div>
            )}
            <fieldset disabled={view.locked} class="compose-fields">
              <Host id="composeForm" class="form-fields" />
            </fieldset>
          </div>
          <div class="compose-foot">
            <p class="compose-stage" data-state role="status">
              {view.stage}
            </p>
            <Progress label="导出" value={view.export} name="export" />
            <Progress label="上传" value={view.upload} name="upload" />
            {view.error && (
              <p class="inline-error" data-error role="alert">
                {view.error}
              </p>
            )}
            {view.bvid && (
              <div class="compose-result" data-result>
                <Icon name="check" />
                <a href={`https://www.bilibili.com/video/${view.bvid}`} target="_blank" rel="noopener noreferrer">
                  {view.bvid}
                </a>
                <button type="button" class="small" onClick={actions.copyBv}>
                  {view.copied ? '已复制' : '复制 BV'}
                </button>
              </div>
            )}
            <div class="compose-actions">
              {view.cancellable && (
                <button type="button" data-cancel onClick={actions.cancel}>
                  取消投稿
                </button>
              )}
              {view.retry && (
                <button type="button" class="tonal" data-retry disabled={view.retryBusy} onClick={actions.retry}>
                  <Icon name="refresh" />
                  重试
                </button>
              )}
              {view.bvid ? (
                <button type="button" class="primary" data-continue onClick={actions.close}>
                  <Icon name="scissors" />
                  继续剪这场
                </button>
              ) : (
                <button class="primary" data-confirm disabled={view.locked}>
                  <Icon name="check" />
                  {view.confirmText}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </form>
  );
}

export function CoverButton({disabled, onClick}) {
  return (
    <button type="button" class="ghost small" id="setCover" disabled={disabled} onClick={onClick}>
      <Icon name="image" />
      设为封面<span class="kbd">C</span>
    </button>
  );
}

// Where the cover frame sits on the timeline, for the record it was taken from.
export function CoverPin({composer, view, record}) {
  const frame = composer.cover.state.value.frame;
  const {start, end} = view.value;
  if (!frame || frame.key !== record?.key || frame.time < start || frame.time > end) return null;
  return (
    <div class="cover-pins">
      <div
        class="cover-pin"
        style={{left: `${((frame.time - start) / (end - start)) * 100}%`}}
        title={`封面 ${formatTime(frame.time, true)}`}
      >
        <Icon name="image" />
      </div>
    </div>
  );
}
