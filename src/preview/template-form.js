import {
  TEXT_FIELDS,
  FLAG_FIELDS,
  ID_FIELDS,
  draftFromTemplate,
  matchingTemplate,
  liveValue,
  substitute,
  submissionFields,
  tagsFrom,
} from './templates.js';

export function createTemplateForm(host) {
  const flags = Object.entries(FLAG_FIELDS)
    .map(([key, label]) => `<label class="switch"><input type="checkbox" role="switch" data-${key}>${label}</label>`)
    .join('');
  const ids = Object.entries(ID_FIELDS)
    .map(([key, label]) => `<div class="field"><label>${label}</label><input type="number" min="1" data-${key}></div>`)
    .join('');
  host.innerHTML = `<div class="field-row">
      <div class="field"><label>投稿模板</label><select data-template></select></div>
      <div class="field"><label>直播场次</label><select data-live></select></div>
    </div>
    <p class="hint" data-schedule-note></p>
    <div class="field" data-live-custom-label hidden><label>自行输入直播信息</label><input data-live-custom placeholder="替换整个 {live}"></div>
    <div class="field"><label>标题<span class="counter" data-title-count></span></label><input data-title required></div>
    <div class="field"><label>标签<span class="counter">逗号分隔，最多 12 个</span></label><input data-tags></div>
    <div class="field"><label>二创署名</label><input data-clipper></div>
    <div class="field"><label>简介</label><textarea data-desc rows="3"></textarea></div>
    <div class="field"><label>简介预览</label><pre class="desc-preview" data-desc-preview></pre></div>
    <details class="advanced"><summary>更多投稿设置</summary><div class="adv-body">
      <div class="field-row">
        <div class="field"><label>分区 ID</label><input data-tid type="number" min="1" max="65535"></div>
        <div class="field"><label>稿件类型</label><select data-copyright><option value="">请选择</option><option value="1">自制</option><option value="2">转载</option></select></div>
      </div>
      <div class="field"><label>转载来源</label><input data-source></div>
      <div class="field"><label>同步动态</label><textarea data-dynamic rows="2"></textarea></div>
      <div class="switches">${flags}<label class="switch"><input type="checkbox" role="switch" data-isOnlySelf>仅自己可见</label></div>
      <div class="field-row">${ids}</div>
      <div class="field"><label>定时发布</label><input type="datetime-local" step="1" data-scheduleAt></div>
      <div class="field"><label>合作成员（JSON：mid、title）</label><textarea data-staff rows="2"></textarea></div>
      <div class="field"><label>简介片段 / @ 用户（JSON：type_id、raw_text、biz_id）</label><textarea data-desc_v2 rows="2"></textarea></div>
    </div></details>`;
  const field = key => host.querySelector(`[data-${key}]`);
  let templates = [],
    events = [];
  const live = () =>
    field('live').value === 'custom' ? field('live-custom').value : liveValue(events[Number(field('live').value)]);
  function preview() {
    field('live-custom-label').hidden = field('live').value !== 'custom';
    field('title-count').textContent = `${[...field('title').value].length}/80`;
    field('desc-preview').textContent = substitute(field('desc').value, live(), field('clipper').value);
  }
  function write(draft) {
    for (const key of [...TEXT_FIELDS, ...Object.keys(ID_FIELDS), 'tid', 'copyright', 'scheduleAt'])
      field(key).value = draft[key] ?? '';
    for (const key of [...Object.keys(FLAG_FIELDS), 'isOnlySelf']) field(key).checked = Boolean(draft[key]);
    field('tags').value = draft.tags.join(', ');
    for (const key of ['staff', 'desc_v2']) field(key).value = draft[key] ? JSON.stringify(draft[key], null, 2) : '';
    preview();
  }
  function option(select, value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    select.append(node);
  }
  field('template').onchange = () => {
    const template = templates.find(item => `${item.kind}:${item.id}` === field('template').value);
    const draft = draftFromTemplate(template?.payload);
    if (!template) draft.tid = null;
    write(draft);
  };
  field('copyright').onchange = () => {
    if (field('copyright').value === '2') field('no_reprint').checked = false;
  };
  host.addEventListener('input', preview);
  field('live').onchange = preview;
  return {
    configure(items, schedule, name, preserve) {
      const selected = field('template').value;
      templates = items;
      field('template').replaceChildren();
      option(field('template'), '', '不使用模板');
      for (const template of templates)
        option(
          field('template'),
          `${template.kind}:${template.id}`,
          `${template.name}（${template.kind === 'shared' ? '共享' : '我的'}）`,
        );
      const matched = matchingTemplate(templates, schedule.matched);
      field('template').value = preserve ? selected : matched ? `${matched.kind}:${matched.id}` : '';
      field('schedule-note').textContent = schedule.failed
        ? '部分日程读取失败，可自行输入直播信息或重新打开投稿。'
        : '';
      if (!preserve) {
        events = [...schedule.recent];
        let index = events.findIndex(
          event => event === schedule.matched || (event.uid && event.uid === schedule.matched?.uid),
        );
        if (schedule.matched && index < 0) {
          index = events.length;
          events.push(schedule.matched);
        }
        field('live').replaceChildren();
        events.forEach((event, i) =>
          option(field('live'), String(i), `${liveValue(event)}${i === index ? '（当前录像）' : ''}`),
        );
        option(field('live'), 'custom', '自行输入');
        field('live').value = index >= 0 ? String(index) : events.length ? '0' : 'custom';
        field('live-custom').value = '';
        field('clipper').value = name || '';
        field('template').onchange();
      }
      preview();
    },
    fields() {
      const draft = {};
      for (const key of [...TEXT_FIELDS, 'scheduleAt']) draft[key] = field(key).value;
      for (const key of [...Object.keys(FLAG_FIELDS), 'isOnlySelf']) draft[key] = field(key).checked;
      for (const key of [...Object.keys(ID_FIELDS), 'tid', 'copyright'])
        draft[key] = field(key).value ? Number(field(key).value) : null;
      draft.tags = tagsFrom(field('tags').value);
      for (const key of ['staff', 'desc_v2']) {
        if (!field(key).value.trim()) continue;
        try {
          const rows = JSON.parse(field(key).value);
          if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))
            throw new Error();
          draft[key] = draftFromTemplate({[key]: rows})[key];
        } catch {
          throw new Error(`${key === 'staff' ? '合作成员' : '简介片段'}需要有效的 JSON 数组`);
        }
      }
      try {
        return submissionFields(draft, live(), field('clipper').value);
      } catch (error) {
        host.querySelector('details').open = true;
        throw error;
      }
    },
  };
}
