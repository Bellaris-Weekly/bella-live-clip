export const COVER_WIDTH = 1920,
  COVER_HEIGHT = 1080,
  ASPECT = 16 / 9;

export function centerCrop(width, height) {
  const w = Math.min(width, height * ASPECT),
    h = w / ASPECT;
  return {x: (width - w) / 2, y: (height - h) / 2, w, h};
}

export function clampCrop(rect, width, height) {
  const max = centerCrop(width, height),
    w = Math.max(Math.min(rect.w, max.w), Math.min(max.w, 32)),
    h = w / ASPECT;
  return {w, h, x: Math.min(Math.max(rect.x, 0), width - w), y: Math.min(Math.max(rect.y, 0), height - h)};
}

export function renderCover(canvas, source, crop, text) {
  canvas.width = COVER_WIDTH;
  canvas.height = COVER_HEIGHT;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, COVER_WIDTH, COVER_HEIGHT);
  if (text?.value) {
    context.font = `bold ${text.size}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.fillStyle = text.fill;
    context.strokeStyle = text.stroke;
    context.lineWidth = text.width;
    if (text.width > 0) context.strokeText(text.value, text.x, text.y, COVER_WIDTH);
    context.fillText(text.value, text.x, text.y, COVER_WIDTH);
  }
}

export function createCoverEditor({host, selection, readFrame, signal}) {
  host.innerHTML = `<label>封面画面 <input data-frame type="range" step="0.1"></label><span data-status role="status"></span>
    <button type="button" data-reload>重新加载</button>
    <canvas data-source aria-label="拖动裁剪框" style="max-width:100%;max-height:260px;touch-action:none"></canvas>
    <label>裁剪范围 <input data-zoom type="range" min="20" max="100" value="100"></label>
    <label>文字（可选）<input data-text maxlength="80"></label>
    <label>字号 <input data-size type="number" min="12" max="300" value="90"></label>
    <label>文字颜色 <input data-fill type="color" value="#ffffff"></label>
    <label>描边颜色 <input data-stroke type="color" value="#000000"></label>
    <label>描边宽度 <input data-width type="number" min="0" max="30" value="6"></label>
    <p>拖动上图裁剪框；拖动下图调整文字位置。</p>
    <canvas data-output aria-label="封面效果，拖动调整文字位置" style="width:100%;touch-action:none"></canvas>`;
  const $ = name => host.querySelector(`[data-${name}]`),
    sourceCanvas = $('source'),
    output = $('output');
  const slider = $('frame');
  slider.min = selection.start;
  slider.max = Math.max(selection.start, selection.end - 0.05);
  slider.value = (selection.start + selection.end) / 2;
  let source,
    crop,
    loading,
    pending,
    timer,
    disposed = false;
  const text = {value: '', size: 90, fill: '#ffffff', stroke: '#000000', width: 6, x: 960, y: 850};
  function draw() {
    if (!source) return;
    sourceCanvas.width = source.width;
    sourceCanvas.height = source.height;
    const context = sourceCanvas.getContext('2d');
    context.drawImage(source, 0, 0);
    context.strokeStyle = '#ffb52e';
    context.lineWidth = Math.max(2, source.width / 300);
    context.strokeRect(crop.x, crop.y, crop.w, crop.h);
    renderCover(output, source, crop, text);
  }
  function frame() {
    clearTimeout(timer);
    timer = null;
    loading?.abort();
    const own = (loading = new AbortController());
    const combined = AbortSignal.any([signal, own.signal]);
    source = null;
    $('status').textContent = '正在加载画面…';
    pending = (async () => {
      const image = await readFrame(Number(slider.value), combined);
      combined.throwIfAborted();
      source = image;
      crop = centerCrop(source.width, source.height);
      $('zoom').value = 100;
      $('status').textContent = '';
      draw();
    })();
    void pending.catch(error => {
      if (!combined.aborted) $('status').textContent = `封面加载失败：${error.message}`;
    });
  }
  slider.oninput = () => {
    source = null;
    loading?.abort();
    clearTimeout(timer);
    timer = setTimeout(frame, 200);
  };
  $('reload').onclick = frame;
  $('zoom').oninput = () => {
    if (!source) return;
    const w = (centerCrop(source.width, source.height).w * Number($('zoom').value)) / 100;
    crop = clampCrop(
      {...crop, w, x: crop.x + (crop.w - w) / 2, y: crop.y + (crop.h - w / ASPECT) / 2},
      source.width,
      source.height,
    );
    draw();
  };
  for (const key of ['text', 'size', 'fill', 'stroke', 'width'])
    $('' + key).oninput = () => {
      const field = key === 'text' ? 'value' : key;
      text[field] = ['size', 'width'].includes(key) ? Number($(key).value) : $(key).value;
      draw();
    };
  function drag(canvas, move) {
    let start;
    canvas.onpointerdown = event => {
      if (!source || host.closest('fieldset')?.disabled) return;
      canvas.setPointerCapture(event.pointerId);
      start = {x: event.clientX, y: event.clientY, crop: {...crop}, text: {...text}};
    };
    canvas.onpointermove = event => {
      if (!start || host.closest('fieldset')?.disabled) return;
      const bounds = canvas.getBoundingClientRect();
      move(
        start,
        ((event.clientX - start.x) * canvas.width) / bounds.width,
        ((event.clientY - start.y) * canvas.height) / bounds.height,
      );
      draw();
    };
    canvas.onpointerup = canvas.onpointercancel = () => {
      start = null;
    };
  }
  drag(sourceCanvas, (start, dx, dy) => {
    crop = clampCrop({...start.crop, x: start.crop.x + dx, y: start.crop.y + dy}, source.width, source.height);
  });
  drag(output, (start, dx, dy) => {
    text.x = Math.max(0, Math.min(COVER_WIDTH, start.text.x + dx));
    text.y = Math.max(0, Math.min(COVER_HEIGHT, start.text.y + dy));
  });
  frame();
  return {
    async file() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        frame();
      }
      await pending;
      signal.throwIfAborted();
      if (disposed || !source) throw new Error('请先选择封面画面');
      renderCover(output, source, crop, text);
      const blob = await new Promise(resolve => output.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) throw new Error('封面导出失败');
      if (blob.size > 5 * 1024 ** 2) throw new Error('封面超过 5 MB，请调整裁剪');
      return new File([blob], 'cover-wide.jpg', {type: 'image/jpeg'});
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      loading?.abort();
      source = null;
    },
  };
}
