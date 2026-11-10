import {Component} from 'preact';
import {Icon} from './icon.jsx';
import {markTime} from '../preview/marks.js';

// The template form and cover editor build their own fields; they render once and keep them.
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

// The form hosts exist before the composer does: it builds its fields into them.
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
      <div class="side-head">
        <h2>投稿</h2>
        <span class="spacer" />
        <button
          type="button"
          class="icon small"
          aria-label="收起投稿（不中断）"
          title="收起投稿（不中断）"
          onClick={actions.close}
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="side-body compose-body">
        <p class="hint" data-selection>
          {view.selection}
        </p>
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
          <div class="field">
            <span class="label">封面</span>
            <Host id="composeCover" class="cover-editor" />
          </div>
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
          {!view.bvid && (
            <button class="primary" data-confirm disabled={view.locked}>
              <Icon name="check" />
              {view.confirmText}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
