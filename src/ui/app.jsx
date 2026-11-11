import {options, render} from 'preact';
import {Icon} from './icon.jsx';
import {Library} from './library.jsx';
import {Editor} from './editor.jsx';
import {Settings} from './settings.jsx';
import {FeedbackSheet} from './feedback.jsx';
import {dismissToast} from '../app/store.js';

const EDGES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

const BrandMark = () => (
  <span class="brand-mark" aria-hidden="true">
    <Icon name="scissors" />
  </span>
);

function Launcher({store, actions}) {
  const marks = store.extras.value?.marks;
  // On a live room the launcher also marks, without opening the panel.
  const canMark = marks && store.identity.value && marks.state.live.value;
  return (
    <div id="launcher" data-busy={String(store.busy.value)}>
      <button type="button" id="openPanel" aria-label="贝报切片助手" title="贝报切片助手" onClick={actions.launch}>
        <BrandMark />
        切片
      </button>
      {canMark && (
        <>
          <span class="split" />
          <button
            type="button"
            id="launcherMark"
            title={`记轴（${marks.state.shortcut.value}）`}
            onClick={marks.actions.capture}
          >
            <Icon name="flag" />
            记轴
          </button>
        </>
      )}
    </div>
  );
}

function Mini({store}) {
  const extras = store.extras.value;
  if (!extras?.marks || store.open.value || !store.identity.value) return null;
  return <extras.ui.MiniMarks marks={extras.marks} onExpand={extras.expand} />;
}

function Header({store, actions, loggedOut, feedback}) {
  const page = store.page.value,
    record = store.record.value,
    version = store.version.value;
  const editing = page === 'edit' && record;
  return (
    <header id="header">
      <BrandMark />
      {editing ? (
        <div class="crumb">
          <button
            type="button"
            class="icon"
            aria-label="返回场次列表"
            title="返回场次列表"
            disabled={store.busy.value}
            onClick={actions.back}
          >
            <Icon name="back" />
          </button>
          <strong id="recordTitle" title={record.title}>
            {record.title}
          </strong>
        </div>
      ) : (
        <h1>贝报切片助手</h1>
      )}
      <span class="head-meta">{editing ? store.recordMeta.value : ''}</span>
      {editing && (
        <button
          type="button"
          class="icon"
          id="refreshEditor"
          aria-label={record.kind === 'submission' ? '重新加载视频' : '刷新录像'}
          title={record.kind === 'submission' ? '重新加载视频' : '刷新录像'}
          disabled={store.busy.value}
          onClick={actions.refreshEditor}
        >
          <Icon name="refresh" />
        </button>
      )}
      {!loggedOut && (
        <>
          <a
            id="version"
            tabIndex={0}
            target="_blank"
            rel="noopener noreferrer"
            href={version.href || undefined}
            role={version.href ? undefined : 'button'}
            title={version.title}
            aria-label={version.description}
            aria-busy={version.busy ? 'true' : undefined}
            data-update={String(version.update)}
            data-checking={String(version.checking)}
            onClick={actions.versionClick}
            onKeyDown={actions.versionKey}
          >
            {version.label}
          </a>
          {feedback && (
            <button
              type="button"
              class="icon"
              aria-label="反馈"
              title="反馈"
              onClick={() => (store.feedbackOpen.value = true)}
            >
              <Icon name="message" />
            </button>
          )}
          <button
            type="button"
            class="icon"
            aria-label="设置"
            title="设置"
            onClick={() => (store.settingsOpen.value = true)}
          >
            <Icon name="gear" />
          </button>
        </>
      )}
      <button type="button" class="icon" id="close" aria-label="收起面板" title="收起面板" onClick={actions.close}>
        <Icon name="close" />
      </button>
    </header>
  );
}

function Offline({store, actions}) {
  const {title, reason} = store.offline.value;
  return (
    <section id="offline" class="state-page" hidden={store.page.value !== 'offline'}>
      <h2>{title}</h2>
      <p>{reason}</p>
      <div class="actions">
        <button type="button" class="primary" disabled={store.busy.value} onClick={actions.library}>
          浏览历史场次
        </button>
        <button type="button" class="ghost" disabled={store.busy.value} onClick={actions.retryCurrent}>
          重新检查
        </button>
      </div>
    </section>
  );
}

function Feedback({store, actions}) {
  const status = store.status.value,
    progress = store.progress.value,
    downloads = store.downloads.value,
    busy = store.busy.value;
  if (!busy && !status.error && !downloads.length) return null;
  return (
    <section id="feedback" aria-label="进度">
      <div class="row">
        <div id="status" role="status" aria-live="polite" data-error={String(status.error)}>
          {status.text}
        </div>
        {busy && (
          <button type="button" class="small" id="cancel" disabled={store.stopping.value} onClick={actions.cancel}>
            停止
          </button>
        )}
      </div>
      {busy && progress !== null && (
        <div
          class={`meter${Number.isNaN(progress) ? ' is-indeterminate' : ''}`}
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Number.isNaN(progress) ? undefined : Math.round(progress)}
        >
          <span style={{width: `${Number.isNaN(progress) ? 30 : progress}%`}} />
        </div>
      )}
      {downloads.length > 0 && (
        <div id="downloads">
          {downloads.map(text => (
            <p key={text}>{text}</p>
          ))}
        </div>
      )}
    </section>
  );
}

function Toasts({store}) {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {store.toasts.value.map(item => (
        <div key={item.id} class={`toast${item.error ? ' is-error' : ''}`}>
          <span>{item.text}</span>
          {item.action && (
            <button
              type="button"
              class="link small"
              onClick={() => {
                dismissToast(store, item.id);
                item.action.run();
              }}
            >
              {item.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function LoginGate({studioUrl, hidden}) {
  return (
    <section id="studioLogin" class="state-page" hidden={hidden}>
      <h2>登录贝报创作台</h2>
      <p>切片助手的内部功能需要先登录。登录完成后回到这里即可使用。</p>
      <div class="actions">
        <a class="button-link" href={`${studioUrl}/plugin/link`} target="_blank" rel="noopener noreferrer">
          登录
        </a>
      </div>
    </section>
  );
}

function Panel({store, actions, preview, members, studioUrl, feedback}) {
  const loggedOut = preview && !store.identity.value;
  return (
    <section
      id="panel"
      hidden={!store.open.value}
      aria-label="贝报切片助手"
      data-logged-out={loggedOut ? '' : undefined}
    >
      <Header store={store} actions={actions} loggedOut={loggedOut} feedback={feedback} />
      <div id="body">
        {preview && <LoginGate studioUrl={studioUrl} hidden={!loggedOut} />}
        <div class="pages" hidden={loggedOut}>
          <Library store={store} actions={actions} members={members} />
          <Editor store={store} actions={actions} />
          <Offline store={store} actions={actions} />
          <Feedback store={store} actions={actions} />
        </div>
      </div>
      <Settings store={store} actions={actions} preview={preview} />
      {feedback && <FeedbackSheet store={store} actions={actions} />}
      {EDGES.map(edge => (
        <span key={edge} class="resize" data-edge={edge} />
      ))}
    </section>
  );
}

export function mountApp(root, props) {
  // Controllers read the DOM right after changing state (focus, scroll, element visibility),
  // so the panel renders synchronously instead of on the next microtask.
  options.debounceRendering = callback => callback();
  render(
    <>
      <Launcher {...props} />
      <Mini {...props} />
      <Panel {...props} />
      <Toasts {...props} />
    </>,
    root,
  );
}
