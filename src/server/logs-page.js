export const logsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>运行日志 · 贝报切片助手</title>
<style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#243c37;background:#f3f7f5;font-size:14px;color-scheme:light}*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button,a,input,select{outline-offset:3px}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}header{background:#fff;border-bottom:1px solid #dce6e1;padding:26px max(24px,calc((100vw - 1400px)/2));display:flex;gap:24px;justify-content:space-between;align-items:center}h1{margin:4px 0;font-size:25px;letter-spacing:-.5px}h2{font-size:17px;margin:0 0 16px}.eyebrow{font-size:11px;letter-spacing:2px;font-weight:700;color:#16836f}p{line-height:1.65}header p{color:#72867f;margin:6px 0 0}main{max-width:1448px;padding:24px;margin:auto}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.button{border:1px solid #cbdad3;border-radius:8px;padding:9px 14px;background:white;color:#29473d}.primary{background:#157e6b;color:white;border-color:#157e6b}form,.panel{background:#fff;border:1px solid #dce6e1;border-radius:12px}form{padding:18px;margin-bottom:18px}.filters{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:14px}label{display:flex;flex-direction:column;gap:7px;font-size:12px;color:#657c71}input,select{min-width:0;width:100%;background:#fcfdfc;border:1px solid #d2ded7;border-radius:7px;padding:9px;color:#243c37}.filters+.toolbar{margin-top:18px}.check{flex-direction:row;align-items:center}.check input{width:auto}.spacer{flex:1}.hint{color:#71847b;font-size:12px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}.card{padding:16px 18px;background:#e9f1ed;border-radius:10px}.card strong{display:block;font-size:26px;margin-top:6px;font-variant-numeric:tabular-nums}.card span{font-size:12px;color:#627c6d}.workspace{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(330px,1fr);gap:18px;align-items:start}.panel{overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;padding:18px;border-bottom:1px solid #e6ede9}.panel-head h2{margin:0}.table-wrap{overflow:auto;max-height:640px}.table-wrap th{position:sticky;top:0;z-index:1}table{width:100%;border-collapse:collapse;text-align:left}th{font-size:11px;letter-spacing:.4px;color:#71877a;background:#f9fbfa;font-weight:600}td,th{padding:13px 12px;border-bottom:1px solid #edf1ee;vertical-align:top}td{font-size:12px}tbody tr:hover{background:#f6faf8}tr.selected{background:#e7f3ed}td small{display:block;color:#789086;margin-top:5px}td button{border:0;background:none;color:#167b67;text-align:left;padding:0;line-height:1.6}.badge{display:inline-block;padding:3px 7px;border-radius:5px;background:#e7f3ec;color:#26714d;font-size:11px;white-space:nowrap}.badge.error{background:#fceae7;color:#b74532}.badge.warn{background:#fff2d4;color:#946719}.pager{padding:14px 18px;display:flex;gap:10px;align-items:center}.detail{padding:20px}.detail p{margin:0 0 14px}.kv{display:grid;grid-template-columns:90px 1fr;gap:8px;font-size:12px;margin-bottom:18px}.kv dt{color:#72867a}.kv dd{margin:0;overflow-wrap:anywhere}.stages{margin:18px -20px 0;width:calc(100% + 40px)}.stages td,.stages th{padding:10px 9px;font-size:11px}.stages th:first-child{padding-left:20px}.stages td:first-child{padding-left:20px}.stage-note{padding-top:14px;font-size:12px;color:#7a887e}.empty{text-align:center;padding:50px 20px;color:#789084}.status{min-height:24px;margin-bottom:12px;font-size:13px;color:#567566}.status.error{color:#b44232}pre{font-size:11px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7f5;padding:12px;border-radius:7px;max-height:440px;overflow:auto}summary{cursor:pointer;color:#3a6b58;padding:14px 0}details{margin-top:14px}#notice{margin:0}.mono{font-family:ui-monospace,Consolas,monospace}.footer{font-size:12px;color:#7f9087;margin-top:18px}
@media(max-width:1050px){.workspace{grid-template-columns:1fr}.filters{grid-template-columns:repeat(3,1fr)}header{align-items:flex-start}.cards{gap:8px}}
@media(max-width:650px){header{padding:20px;flex-direction:column;gap:12px}main{padding:14px}.filters{grid-template-columns:repeat(2,minmax(0,1fr))}.cards{grid-template-columns:repeat(2,1fr)}h1{font-size:22px}.toolbar{gap:8px}.card strong{font-size:23px}}
</style></head><body>
<header><div><div class="eyebrow">BELLA / OBSERVABILITY</div><h1>运行日志</h1><p>查看导出过程，定位处理与等待耗时。</p></div><div class="toolbar"><label class="check"><input type="checkbox" id="auto">每 10 秒刷新</label><button class="button primary" id="download">下载筛选日志</button></div></header>
<main><form id="filters"><div class="filters">
<label>开始时间<input type="datetime-local" name="from" id="from"></label><label>结束时间<input type="datetime-local" name="to" id="to"></label>
<label>导出方式<select name="mode"><option value="">全部方式</option><option value="danmaku">弹幕</option><option value="precise">精确</option><option value="copy">原画</option><option value="whole">整场</option></select></label>
<label>运行状态<select name="outcome"><option value="">全部状态</option><option value="started">开始</option><option value="progress">运行中</option><option value="stalled">进度停滞</option><option value="completed">完成</option><option value="stopped">停止并保存</option><option value="canceled">取消</option><option value="failed">失败</option></select></label>
<label>来源<input name="source" value="bella-live-clip" placeholder="全部来源"></label><label>任务编号<input name="operation" placeholder="关联一次导出的所有日志" autocomplete="off"></label>
<label>版本<input name="version" placeholder="全部版本"></label><label>级别<select name="level"><option value="">全部级别</option><option value="info">正常</option><option value="warn">警告</option><option value="error">错误</option></select></label>
</div><div class="toolbar"><button class="button primary" type="submit">查询日志</button><button class="button" type="button" id="resetFilters">重置</button><span class="spacer"></span><span class="hint">下载 JSONL，包含完整上下文；单次最多 5,000 条。</span></div></form>
<div id="notice" class="status" role="status" aria-live="polite"></div>
<div class="cards"><div class="card"><span>当前页记录</span><strong id="total">—</strong></div><div class="card"><span>当前页完成导出</span><strong id="completed">—</strong></div><div class="card"><span>当前页失败 / 停滞</span><strong id="issues">—</strong></div><div class="card"><span>当前页完成导出 · 平均倍速</span><strong id="speed">—</strong></div></div>
<div class="workspace"><section class="panel"><div class="panel-head"><h2>日志记录</h2><span class="hint" id="updated">尚未加载</span></div><div class="table-wrap"><table><thead><tr><th>收到时间</th><th>事件 / 阶段</th><th>方式</th><th>状态</th><th>耗时</th></tr></thead><tbody id="rows"></tbody></table></div><div id="empty" class="empty" hidden>这个时间范围内还没有日志。</div><div class="pager"><button class="button" id="previous" disabled>上一页</button><button class="button" id="next" disabled>下一页</button><span id="page" class="hint"></span></div></section>
<section class="panel"><div class="panel-head"><h2>运行详情</h2></div><div id="detail" class="detail"><div class="empty">选择一条日志，查看阶段耗时和等待情况。</div></div></section></div>
<p class="footer">时间按当前浏览器时区显示。阶段计时可能重叠；累计等待时间不能相加当作总耗时。硬件偏好不代表实际硬件利用率。</p>
</main><script src="/viewer.js" defer></script></body></html>`;

// Self-contained so the Worker can serve it without a separate assets deployment.
export function startLogViewer() {
  const $ = id => document.getElementById(id),
    form = $('filters');
  const modes = {danmaku: '弹幕', precise: '精确', copy: '原画', whole: '整场'};
  const outcomes = {
    started: '开始',
    progress: '运行中',
    stalled: '停滞',
    completed: '完成',
    stopped: '已保存',
    canceled: '取消',
    failed: '失败',
  };
  const labels = {
    archiveSetup: '归档准备',
    archiveOpen: '归档元数据',
    archiveRead: '弹幕窗口读取',
    emoteCatalog: '表情目录',
    emoteLoad: '表情下载 / 初始化',
    emoteFrame: '表情帧解码',
    playlistLoad: '录像清单读取',
    mediaIndex: '投稿媒体索引',
    fileOpen: '文件打开',
    mediaRequest: '媒体请求',
    mediaPrepare: '录像整理',
    streamReady: '流式首段准备',
    streamWriteWait: '生产端等待读取',
    sampleWait: '等待解码帧',
    danmakuPrepare: '弹幕按需准备',
    render: '完整合成',
    layout: '弹幕排布',
    overlayDraw: '弹幕层绘制',
    overlayComposite: '透明层混合',
    videoDraw: '视频帧绘制',
    frameSnapshot: '生成视频帧',
    encoderSetup: '编码器初始化',
    encodeSubmit: '编码提交 / 背压',
    encoderFlush: '编码器收尾',
    muxAdd: '封装提交 / 背压',
    fileWrite: '文件写入',
    fileClose: '文件关闭',
    outputFinalize: '封装收尾',
  };
  const duration = ms =>
    typeof ms !== 'number' || !Number.isFinite(ms)
      ? '—'
      : ms < 1000
        ? `${ms.toFixed(1)} ms`
        : `${(ms / 1000).toFixed(2)} s`;
  const number = value =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString(undefined, {maximumFractionDigits: 2})
      : '—';
  const date = value => (value ? new Date(value).toLocaleString() : '—');
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const notice = (text, error = false) => {
    $('notice').textContent = text;
    $('notice').className = `status${error ? ' error' : ''}`;
  };
  let nextCursor = null,
    cursors = [null],
    selected,
    controller;
  function parameters() {
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form))
      if (String(value).trim())
        params.set(key, key === 'from' || key === 'to' ? new Date(value).toISOString() : String(value).trim());
    return params;
  }
  function reset() {
    form.reset();
    const date = new Date(Date.now() - 86400000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    $('from').value = date.toISOString().slice(0, 16);
  }
  function showDetail(log) {
    selected = log.id + '/' + log.source;
    for (const row of $('rows').children) row.classList.toggle('selected', row.dataset.key === selected);
    const context = log.context ?? {},
      operation = context.operation ?? {},
      metrics = context.metrics ?? {};
    const detail = $('detail');
    detail.replaceChildren();
    detail.append(node('p', log.message));
    const values = node('dl', undefined, 'kv');
    for (const [key, value] of [
      ['任务编号', operation.id ?? '旧版记录，无任务编号'],
      ['事件', log.event],
      ['版本 / 来源', `${log.version} / ${log.source}`],
      ['方式', modes[context.mode] ?? context.mode ?? '—'],
      ['开始时间', date(operation.startedAt)],
      ['操作耗时', duration(operation.elapsedMs)],
      ['处理耗时', duration(metrics.elapsedMs)],
      ['首个编码包', duration(metrics.firstPacketMs)],
      ['已处理帧', number(metrics.counters?.videoFrames ?? context.progress?.videoFrames)],
      [
        '处理视频时长',
        context.progress?.processedSeconds === undefined ? '—' : `${number(context.progress.processedSeconds)} 秒`,
      ],
      ['处理帧率 / 倍速', `${number(context.throughput?.fps)} fps / ${number(context.throughput?.realtime)}×`],
      ['进度未推进', duration(context.runtime?.noAdvanceMs)],
      ['主线程定时延迟', duration(context.runtime?.timerDelayMs)],
      ['页面状态', context.runtime?.visibility ?? '—'],
      [
        '编码规格',
        metrics.encoder?.codec
          ? `${metrics.encoder.codec} · ${metrics.encoder.width}×${metrics.encoder.height} · ${number(metrics.encoder.frameRate)} fps`
          : '—',
      ],
      ['硬件请求偏好', metrics.encoder?.hardwarePreference ?? '—'],
      ['浏览器', context.browser ?? '—'],
    ])
      values.append(node('dt', key), node('dd', value));
    detail.append(values);
    if (operation.id) {
      const button = node('button', '只看这次任务', 'button');
      button.onclick = () => {
        form.elements.operation.value = operation.id;
        form.elements.source.value = log.source;
        for (const key of ['from', 'to', 'mode', 'outcome', 'level', 'version']) form.elements[key].value = '';
        cursors = [null];
        void load();
      };
      detail.append(button);
    }
    const stages = new Set([...Object.keys(metrics.stages ?? {}), ...Object.keys(metrics.active ?? {})]);
    if (stages.size) {
      const table = node('table', undefined, 'stages'),
        head = node('thead'),
        titles = node('tr');
      for (const title of ['阶段', '次数', '累计', '单次最大', '正在等待']) titles.append(node('th', title));
      head.append(titles);
      table.append(head);
      const body = node('tbody');
      for (const key of [...stages].sort(
        (a, b) => (metrics.stages?.[b]?.totalMs ?? 0) - (metrics.stages?.[a]?.totalMs ?? 0),
      )) {
        const stage = metrics.stages?.[key] ?? {},
          active = metrics.active?.[key];
        const row = node('tr');
        for (const value of [
          labels[key] ?? key,
          number(stage.count),
          duration(stage.totalMs),
          duration(stage.maxMs),
          active ? `${duration(active.oldestMs)} (${active.count})` : '—',
        ])
          row.append(node('td', value));
        body.append(row);
      }
      table.append(body);
      detail.append(
        table,
        node(
          'p',
          '这些是累计调用耗时，包含并发等待与嵌套阶段，不能相加。分位耗时上界、缓冲峰值和完整计数见原始数据。',
          'stage-note',
        ),
      );
    }
    const raw = node('details'),
      summary = node('summary', '原始日志 JSON');
    raw.append(summary, node('pre', JSON.stringify(log, null, 2)));
    detail.append(raw);
  }
  function render(logs) {
    const body = $('rows');
    body.replaceChildren();
    for (const log of logs) {
      const context = log.context ?? {},
        operation = context.operation ?? {},
        row = node('tr');
      row.dataset.key = log.id + '/' + log.source;
      const time = node('td', date(log.received_at)),
        event = node('td');
      const button = node('button', log.event);
      button.onclick = () => showDetail(log);
      event.append(button, node('small', context.progress?.message ?? context.stage ?? ''));
      const status = node('td');
      status.append(
        node(
          'span',
          outcomes[operation.outcome] ?? log.level,
          `badge ${log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : ''}`,
        ),
      );
      row.append(
        time,
        event,
        node('td', modes[context.mode] ?? context.mode ?? '—'),
        status,
        node('td', duration(operation.elapsedMs)),
      );
      body.append(row);
    }
    $('empty').hidden = logs.length > 0;
    const finished = logs.filter(
      log =>
        ['export', 'recording_download'].includes(log.context?.operation?.action) &&
        ['completed', 'stopped'].includes(log.context?.operation?.outcome),
    );
    const speeds = finished.map(log => log.context?.throughput?.realtime).filter(Number.isFinite);
    $('total').textContent = logs.length;
    $('completed').textContent = finished.length;
    $('issues').textContent = logs.filter(log => ['error', 'warn'].includes(log.level)).length;
    $('speed').textContent = speeds.length ? `${number(speeds.reduce((a, b) => a + b, 0) / speeds.length)}×` : '—';
    const current = logs.find(log => log.id + '/' + log.source === selected);
    if (current) showDetail(current);
  }
  async function load() {
    controller?.abort();
    const own = new AbortController();
    controller = own;
    $('next').disabled = $('previous').disabled = true;
    notice('正在读取日志…');
    try {
      const params = parameters();
      if (cursors.at(-1)) params.set('cursor', cursors.at(-1));
      const response = await fetch('/api/logs?' + params, {signal: own.signal});
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          {
            invalid_filter: '请检查筛选条件中的字符',
            invalid_time: '时间格式无效',
            invalid_time_range: '开始时间不能晚于结束时间',
            storage_unavailable: '日志存储暂时不可用',
          }[result.error] ?? result.error,
        );
      nextCursor = result.nextCursor;
      render(result.logs);
      $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
      $('page').textContent = `第 ${cursors.length} 页 · ${result.logs.length} 条`;
      notice(result.logs.length ? '点击事件查看详细耗时。' : '没有符合条件的记录。');
    } catch (error) {
      if (error.name !== 'AbortError') {
        nextCursor = null;
        notice('日志读取失败：' + error.message, true);
      }
    } finally {
      if (controller === own) {
        $('next').disabled = !nextCursor;
        $('previous').disabled = cursors.length <= 1;
        controller = null;
      }
    }
  }
  form.onsubmit = event => {
    event.preventDefault();
    cursors = [null];
    nextCursor = null;
    void load();
  };
  $('resetFilters').onclick = () => {
    reset();
    cursors = [null];
    nextCursor = null;
    void load();
  };
  $('next').onclick = () => {
    if (nextCursor) {
      cursors.push(nextCursor);
      void load();
    }
  };
  $('previous').onclick = () => {
    if (cursors.length > 1) {
      cursors.pop();
      void load();
    }
  };
  $('download').onclick = async () => {
    const button = $('download');
    button.disabled = true;
    try {
      const params = parameters();
      const check = await fetch('/api/logs/download?' + params, {method: 'HEAD'});
      if (!check.ok)
        throw new Error(check.status === 413 ? '超过 5,000 条，请缩小时间范围后下载。' : `HTTP ${check.status}`);
      params.set('to', check.headers.get('X-Log-Snapshot'));
      const link = node('a');
      link.href = '/api/logs/download?' + params;
      link.download = '';
      document.body.append(link);
      link.click();
      link.remove();
      notice(`已开始下载 ${check.headers.get('X-Log-Count')} 条日志。`);
    } catch (error) {
      notice('下载失败：' + error.message, true);
    } finally {
      button.disabled = false;
    }
  };
  setInterval(() => {
    if ($('auto').checked && !document.hidden && cursors.length === 1 && !controller) void load();
  }, 10000);
  reset();
  void load();
}
