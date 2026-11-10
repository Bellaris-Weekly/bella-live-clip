import {useEffect, useRef} from 'preact/hooks';
import {Icon} from './icon.jsx';

function Stepper({label, value, onChange, step = 5}) {
  return (
    <div class="stepper">
      <button type="button" aria-label={`${label}减少 ${step} 秒`} onClick={() => onChange(Math.max(0, value - step))}>
        −
      </button>
      <input
        type="number"
        min="0"
        max="3600"
        aria-label={`${label}（秒）`}
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
      />
      <button type="button" aria-label={`${label}增加 ${step} 秒`} onClick={() => onChange(value + step)}>
        +
      </button>
    </div>
  );
}

export function Settings({store, actions, preview}) {
  const open = store.settingsOpen.value,
    identity = store.identity.value,
    marks = store.extras.value?.marks;
  const sheet = useRef(null);
  const close = () => (store.settingsOpen.value = false);
  useEffect(() => {
    if (open) sheet.current?.querySelector('button')?.focus({preventScroll: true});
  }, [open]);
  return (
    <div class="sheet-layer" hidden={!open}>
      <div class="scrim" onClick={close} />
      <section
        class="sheet"
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onKeyDown={event => {
          if (event.key === 'Escape' && !event.target.classList.contains('shortcut-field')) {
            event.stopPropagation();
            close();
          }
        }}
      >
        <div class="sheet-head">
          <h2>设置</h2>
          <button type="button" class="icon" aria-label="关闭设置" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div class="sheet-body">
          {preview && identity && (
            <div class="card group">
              <div class="group-row">
                <span class="avatar" aria-hidden="true">
                  {identity.name?.[0] || '?'}
                </span>
                <div class="grow">
                  <b>{identity.name}</b>
                  <small>已登录贝报创作台</small>
                </div>
                <button type="button" class="small" onClick={actions.logout}>
                  <Icon name="logout" />
                  退出
                </button>
              </div>
            </div>
          )}
          <p class="section-label">快捷键</p>
          <div class="card group">
            <div class="group-row">
              <label class="grow" for="shortcut">
                打开面板
              </label>
              <input id="shortcut" class="shortcut-field" readOnly title="点击后按下新的快捷键" />
            </div>
            {preview && (
              <div class="group-row">
                <label class="grow" for="markShortcut">
                  记轴<small>直播页任何时候都可用</small>
                </label>
                <input id="markShortcut" class="shortcut-field" readOnly title="点击后按下新的快捷键" />
              </div>
            )}
          </div>
          {marks && (
            <>
              <p class="section-label">从轴生成选段</p>
              <div class="card group">
                <div class="group-row">
                  <span class="grow">入点提前</span>
                  <Stepper
                    label="入点提前"
                    value={marks.state.margins.value.before}
                    onChange={value => marks.actions.setMargin('before', value)}
                  />
                </div>
                <div class="group-row">
                  <span class="grow">出点延后</span>
                  <Stepper
                    label="出点延后"
                    value={marks.state.margins.value.after}
                    onChange={value => marks.actions.setMargin('after', value)}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
