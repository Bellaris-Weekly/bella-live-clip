import {useEffect, useRef, useState} from 'preact/hooks';
import {Icon} from './icon.jsx';
import {
  OUTPUTS,
  TEXT_COLORS,
  TEXT_STYLES,
  cropRect,
  drawCover,
  layerOf,
  readImage,
  sourceOf,
} from '../preview/cover.js';
import {formatTime} from '../shared/format.js';

const KEYS = ['wide', 'tall'];
const HANDLE = 0.04;

// Paints a cover at the canvas's on-screen size; the editor adds its own guides on top.
function paint(canvas, state, key, guides) {
  const out = OUTPUTS[key],
    bounds = canvas.getBoundingClientRect(),
    ratio = window.devicePixelRatio || 1;
  const width = Math.round(bounds.width * ratio),
    height = Math.round(bounds.height * ratio);
  if (!width || !height) return null;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  context.setTransform(width / out.width, 0, 0, height / out.height, 0, 0);
  const box = drawCover(context, state, key);
  if (guides) {
    const unit = out.height / 400;
    context.save();
    context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    context.lineWidth = unit * 1.5;
    if (guides.x) line(context, out.width / 2, 0, out.width / 2, out.height);
    if (guides.y) line(context, 0, out.height / 2, out.width, out.height / 2);
    if (box) {
      context.setLineDash([unit * 6, unit * 4]);
      context.strokeRect(box.x, box.y, box.w, box.h);
      context.setLineDash([]);
      const size = out.height * HANDLE;
      context.fillStyle = '#ffffff';
      context.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      context.beginPath();
      context.arc(box.x + box.w, box.y + box.h, size / 2, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();
  }
  return box;
}
function line(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}
function useRepaint(ref, draw, deps) {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    draw(canvas);
    const observer = new ResizeObserver(() => draw(canvas));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, deps);
}

function Stage({cover, state, active, disabled}) {
  const canvas = useRef(null),
    box = useRef(null),
    drag = useRef(null);
  const [guides, setGuides] = useState(null),
    [dropping, setDropping] = useState(false);
  const out = OUTPUTS[active];
  const layer = layerOf(state, active),
    source = sourceOf(state, layer);
  useRepaint(canvas, element => (box.current = paint(element, state, active, guides || {})), [state, active, guides]);
  const point = event => {
    const bounds = canvas.current.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * out.width,
      y: ((event.clientY - bounds.top) / bounds.height) * out.height,
    };
  };
  function hit(p) {
    const b = box.current;
    if (b && Math.hypot(p.x - b.x - b.w, p.y - b.y - b.h) < out.height * HANDLE) return 'size';
    const pad = out.height * 0.02;
    if (b && p.x > b.x - pad && p.x < b.x + b.w + pad && p.y > b.y - pad && p.y < b.y + b.h + pad) return 'text';
    return source ? 'pan' : null;
  }
  const cursors = {size: 'nwse-resize', text: 'move', pan: 'grab'};
  function down(event) {
    if (disabled || event.button !== 0) return;
    const p = point(event),
      mode = hit(p);
    if (!mode) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const b = box.current;
    drag.current = {
      mode,
      p,
      pos: layer.pos,
      rect: source && cropRect(source, out.ratio, layer.crop),
      zoom: layer.crop?.zoom ?? 1,
      size: state.text.size,
      center: b && {x: b.x + b.w / 2, y: b.y + b.h / 2},
      reach: b && Math.max(1, Math.hypot(p.x - b.x - b.w / 2, p.y - b.y - b.h / 2)),
    };
    if (mode === 'pan') event.currentTarget.style.cursor = 'grabbing';
  }
  function move(event) {
    const p = point(event),
      start = drag.current;
    if (!start) {
      event.currentTarget.style.cursor = disabled ? 'default' : cursors[hit(p)] || 'default';
      return;
    }
    const dx = p.x - start.p.x,
      dy = p.y - start.p.y;
    if (start.mode === 'pan') cover.pan(active, start, dx, dy);
    else if (start.mode === 'text') {
      const pos = cover.moveText(active, start.pos.x + dx / out.width, start.pos.y + dy / out.height);
      setGuides({x: pos.x === 0.5, y: pos.y === 0.5});
    } else {
      const reach = Math.hypot(p.x - start.center.x, p.y - start.center.y);
      cover.setText({size: Math.min(0.3, Math.max(0.03, (start.size * reach) / start.reach))});
    }
  }
  function up(event) {
    drag.current = null;
    setGuides(null);
    event.currentTarget.style.cursor = '';
  }
  function wheel(event) {
    if (disabled || !source) return;
    event.preventDefault();
    const p = point(event);
    cover.zoom(active, Math.exp(-event.deltaY * 0.0015), {x: p.x / out.width, y: p.y / out.height});
  }
  async function drop(event) {
    event.preventDefault();
    setDropping(false);
    if (disabled) return;
    try {
      cover.setImage(active, await readImage(event.dataTransfer.files[0]));
    } catch (error) {
      cover.notice.value = error.message;
    }
  }
  return (
    <div
      class={`cover-stage${dropping ? ' is-dropping' : ''}`}
      onDragOver={event => {
        if (disabled || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={drop}
    >
      <canvas
        ref={canvas}
        data-cover-canvas
        // Same height as the 16:9 stage: 4:3 is three quarters as wide.
        style={{width: `${(out.ratio / OUTPUTS.wide.ratio) * 100}%`}}
        aria-label={`${out.label} 封面：拖动画面调整位置，滚轮缩放；拖动文字移动，拖右下角圆点改大小`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={wheel}
      />
      {!source && <p class="cover-empty">{cover.notice.value || '正在截取封面画面…'}</p>}
      {dropping && <p class="cover-drop">松开即用这张图片做 {out.label} 封面</p>}
    </div>
  );
}

function Ratios({cover, state, active}) {
  return (
    <div class="cover-ratios" role="tablist" aria-label="封面比例">
      {KEYS.map(key => (
        <Ratio key={key} cover={cover} state={state} ratioKey={key} selected={key === active} />
      ))}
    </div>
  );
}
function Ratio({cover, state, ratioKey, selected}) {
  const canvas = useRef(null);
  const out = OUTPUTS[ratioKey];
  useRepaint(canvas, element => paint(element, state, ratioKey, null), [state]);
  const following = ratioKey === 'tall' && state.follow;
  return (
    <div class={`cover-ratio${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        role="tab"
        aria-selected={String(selected)}
        data-cover-ratio={ratioKey}
        onClick={() => (cover.active.value = ratioKey)}
      >
        <canvas ref={canvas} style={{aspectRatio: `${out.width} / ${out.height}`}} />
        <span>
          <b>{out.label}</b>
          {following ? '跟随 16:9' : ratioKey === 'wide' ? '横版' : '独立调整'}
        </span>
      </button>
      {ratioKey === 'tall' && !state.follow && (
        <button type="button" class="link small" data-cover-follow onClick={cover.follow}>
          重新跟随 16:9
        </button>
      )}
    </div>
  );
}

function Toolbar({cover, state, active, disabled}) {
  const file = useRef(null);
  const layer = layerOf(state, active),
    zoom = cover.zoomOf(active);
  const frame = state.frame;
  async function pick(event) {
    const chosen = event.currentTarget.files[0];
    event.currentTarget.value = '';
    try {
      cover.setImage(active, await readImage(chosen));
    } catch (error) {
      cover.notice.value = error.message;
    }
  }
  return (
    <div class="cover-bar">
      <span class="cover-source" data-cover-source>
        <Icon name={layer.source === 'image' ? 'image' : 'camera'} />
        {layer.source === 'image' ? '上传的图片' : frame ? `画面 ${formatTime(frame.time, true)}` : '画面'}
      </span>
      {layer.source === 'image' && frame && (
        <button type="button" class="link small" disabled={disabled} onClick={() => cover.useFrame(active)}>
          改用视频画面
        </button>
      )}
      <span class="spacer" />
      <div class="cover-zoom" role="group" aria-label="缩放">
        <button
          type="button"
          class="icon small"
          aria-label="缩小"
          title="缩小"
          disabled={disabled || zoom <= 1}
          onClick={() => cover.zoom(active, 1 / 1.25)}
        >
          <Icon name="minus" />
        </button>
        <span class="mono">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          class="icon small"
          aria-label="放大"
          title="放大"
          disabled={disabled || zoom >= 4}
          onClick={() => cover.zoom(active, 1.25)}
        >
          <Icon name="plus" />
        </button>
      </div>
      <button type="button" class="ghost small" disabled={disabled} onClick={() => cover.resetLayer(active)}>
        复位
      </button>
      <button type="button" class="tonal small" disabled={disabled} onClick={() => file.current.click()}>
        <Icon name="upload" />
        上传图片
      </button>
      <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden data-cover-file onChange={pick} />
    </div>
  );
}

function TextTools({cover, state, active, disabled}) {
  const text = state.text,
    layer = layerOf(state, active);
  return (
    <div class="cover-text">
      <textarea
        data-cover-text
        rows={2}
        maxLength={80}
        placeholder="封面文字（可选），回车换行"
        value={text.value}
        disabled={disabled}
        onInput={event => cover.setText({value: event.currentTarget.value})}
      />
      <div class="cover-style">
        <div class="segmented" role="group" aria-label="文字样式">
          {TEXT_STYLES.map(style => (
            <button
              key={style.id}
              type="button"
              aria-pressed={String(text.style === style.id)}
              disabled={disabled}
              onClick={() => cover.setText({style: style.id})}
            >
              {style.label}
            </button>
          ))}
        </div>
        <div class="swatches" role="group" aria-label="文字颜色">
          {TEXT_COLORS.map(color => (
            <button
              key={color}
              type="button"
              class="swatch"
              style={{background: color}}
              aria-label={`颜色 ${color}`}
              aria-pressed={String(text.color === color)}
              disabled={disabled}
              onClick={() => cover.setText({color})}
            />
          ))}
          <label class="swatch is-custom" title="自定义颜色">
            <input
              type="color"
              value={text.color}
              disabled={disabled}
              onInput={event => cover.setText({color: event.currentTarget.value})}
            />
          </label>
        </div>
        <label class="cover-size">
          字号
          <input
            type="range"
            min="0.03"
            max="0.3"
            step="0.005"
            value={text.size}
            disabled={disabled}
            onInput={event => cover.setText({size: Number(event.currentTarget.value)})}
          />
        </label>
      </div>
      <label class="switch">
        <input
          type="checkbox"
          role="switch"
          checked={layer.showText}
          disabled={disabled}
          onChange={event => cover.showText(active, event.currentTarget.checked)}
        />
        在 {OUTPUTS[active].label} 封面上显示文字
      </label>
    </div>
  );
}

export function CoverEditor({cover, disabled}) {
  const state = cover.state.value,
    active = cover.active.value,
    notice = cover.notice.value;
  const source = sourceOf(state, layerOf(state, active));
  return (
    <div class="cover-editor">
      <Stage cover={cover} state={state} active={active} disabled={disabled} />
      {notice && source && (
        <p class="cover-notice" role="status">
          {notice}
        </p>
      )}
      {!notice && cover.lowResolution(active) && (
        <p class="cover-notice" role="status">
          放得太大了，{OUTPUTS[active].label} 封面会有些模糊。
        </p>
      )}
      <Toolbar cover={cover} state={state} active={active} disabled={disabled} />
      <div class="cover-lower">
        <Ratios cover={cover} state={state} active={active} />
        <TextTools cover={cover} state={state} active={active} disabled={disabled} />
      </div>
      <p class="hint">
        拖动画面调整位置，滚轮缩放；拖动文字移动，拖右下角圆点改大小。也可以把图片拖进来，或直接粘贴（⌘V / Ctrl+V）。
      </p>
    </div>
  );
}
