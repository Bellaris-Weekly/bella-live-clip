import {useEffect, useRef, useState} from 'preact/hooks';
import {Icon} from './icon.jsx';
import {toast} from '../app/store.js';

const LIMIT = 2000;
const KINDS = [
  {
    kind: 'issue',
    label: '问题反馈',
    field: '遇到了什么问题',
    placeholder: '在哪个页面、做了什么操作、出现了什么情况。需要回复的话，可以留下联系方式。',
  },
  {
    kind: 'suggestion',
    label: '功能建议',
    field: '想要什么功能或改进',
    placeholder: '想用它做什么、现在哪里不方便。需要回复的话，可以留下联系方式。',
  },
];
const FAILURES = {
  rate_limited: '提交太频繁了，请过一分钟再试。',
  failed: '没有发送成功，请检查网络后重试。',
};

export function FeedbackSheet({store, actions}) {
  const open = store.feedbackOpen.value;
  const [kind, setKind] = useState('issue'),
    [text, setText] = useState(''),
    [sending, setSending] = useState(false),
    [error, setError] = useState('');
  const field = useRef(null);
  const current = KINDS.find(item => item.kind === kind);
  const close = () => (store.feedbackOpen.value = false);
  useEffect(() => {
    if (open) field.current?.focus({preventScroll: true});
  }, [open]);
  async function submit(event) {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setError('');
    const result = await actions.sendFeedback(kind, text);
    setSending(false);
    if (result !== 'sent') return setError(FAILURES[result] ?? FAILURES.failed);
    setText('');
    close();
    toast(store, `${current.label}已发送，谢谢！`);
  }
  return (
    <div class="sheet-layer" hidden={!open}>
      <div class="scrim" onClick={close} />
      <form
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="反馈"
        onSubmit={submit}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        }}
      >
        <div class="sheet-head">
          <h2>反馈</h2>
          <button type="button" class="icon" aria-label="关闭反馈" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div class="sheet-body feedback-body">
          <div class="segmented" role="group" aria-label="反馈类型">
            {KINDS.map(item => (
              <button
                key={item.kind}
                type="button"
                aria-pressed={String(kind === item.kind)}
                disabled={sending}
                onClick={() => {
                  setKind(item.kind);
                  setError('');
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div class="field">
            <label for="feedbackText">
              {current.field}
              <span class="counter">
                {text.length}/{LIMIT}
              </span>
            </label>
            <textarea
              id="feedbackText"
              ref={field}
              rows={8}
              maxLength={LIMIT}
              placeholder={current.placeholder}
              value={text}
              disabled={sending}
              onInput={event => {
                setText(event.currentTarget.value);
                setError('');
              }}
            />
          </div>
          <p class="hint">会一起附上插件版本、浏览器和当前打开的视频或场次，方便排查。</p>
          {error && (
            <p class="inline-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" class="primary" disabled={sending || !text.trim()}>
            {sending ? '正在发送…' : `发送${current.label}`}
          </button>
        </div>
      </form>
    </div>
  );
}
