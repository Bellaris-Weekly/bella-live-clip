import {
  TEXT_FIELDS,
  FLAG_FIELDS,
  ID_FIELDS,
  draftFromTemplate,
  matchingTemplate,
  liveValue,
  liveValues,
  neededVariables,
  isCollection,
  titleWithSong,
  submissionFields,
  tagsFrom,
} from './templates.js';
import {bindTemplateField} from './template-text.js';

const ANTI_COLLISION = {preset_id: 'anti-collision', title: '✩‧₊˚✧'};

export function createTemplateForm(host) {
  const flags = Object.entries(FLAG_FIELDS)
    .map(([key, label]) => `<label class="switch"><input type="checkbox" role="switch" data-${key}>${label}</label>`)
    .join('');
  const ids = Object.entries(ID_FIELDS)
    .map(([key, label]) => `<div class="field"><label>${label}</label><input type="number" min="1" data-${key}></div>`)
    .join('');
  host.innerHTML = `<div class="field" data-target-label hidden><label>投到</label><select data-target></select></div>
    <div class="field" data-song-label hidden><label>歌名<span class="counter">填进标题的『』，也是分P标题</span></label><input data-song></div>
    <div data-archive>
    <div class="field"><label>投稿模板</label><select data-template></select></div>
    <div class="field"><label>标题<span class="counter" data-title-count></span></label><input data-title required></div>
    <div class="field"><label>标签<span class="counter">逗号分隔，最多 12 个</span></label><input data-tags></div>
    <div class="field"><label>简介</label><textarea data-desc rows="3"></textarea></div>
    <div class="field" data-live-label hidden>
      <label>直播</label><select data-live></select>
      <p class="hint" data-schedule-note></p>
      <div class="field-row" data-live-custom-label hidden>
        <div class="field" data-live-date-label><label>直播日期</label><input type="date" data-live-date></div>
        <div class="field" data-live-title-label><label>直播名</label><input data-live-title placeholder="填写直播标题"></div>
      </div>
    </div>
    <div class="field" data-clipper-label hidden><label>君の名は</label><input data-clipper></div>
    <details class="advanced"><summary>更多投稿设置</summary><div class="adv-body">
      <div class="field-row">
        <div class="field"><label>分区 ID</label><input data-tid type="number" min="1" max="65535"></div>
        <div class="field"><label>稿件类型</label><select data-copyright><option value="">请选择</option><option value="1">自制</option><option value="2">转载</option></select></div>
      </div>
      <div class="field"><label>转载来源</label><input data-source></div>
      <div class="field"><label>同步动态</label><textarea data-dynamic rows="2"></textarea></div>
      <div class="switches">${flags}<label class="switch"><input type="checkbox" role="switch" data-isOnlySelf>仅自己可见</label></div>
      <div class="field-row">${ids}</div>
      <div class="field"><label>定时投稿（北京时间）</label><input type="datetime-local" step="1" data-scheduleAt></div>
      <div class="field"><label>合作成员（JSON：mid、title）</label><textarea data-staff rows="2"></textarea></div>
      <div class="field"><label>简介片段 / @ 用户（JSON：type_id、raw_text、biz_id）</label><textarea data-desc_v2 rows="2"></textarea></div>
    </div></details>
    </div>`;
  const field = key => host.querySelector(`[data-${key}]`);
  let templates = [],
    events = [],
    collections = [],
    start = 0,
    antiCollision = false;
  const values = () => ({
    ...liveValues(field('live').value === 'custom' ? null : events[Number(field('live').value)], {
      date: field('live-date').value,
      title: field('live-title').value,
    }),
    clipper: field('clipper').value,
  });
  // Text fields show their variables resolved, like the studio; their template source is kept here.
  const LIMITS = {title: 80, desc: 2000, source: 200, dynamic: 233};
  const texts = Object.fromEntries(
    TEXT_FIELDS.map(key => [key, bindTemplateField(field(key), values, {maxLength: LIMITS[key]})]),
  );
  const recordDate = () => (start ? new Date((start + 8 * 3600) * 1000).toISOString().slice(0, 10) : '');
  const appending = () => collections[Number(field('target').value)] || null;
  function preview() {
    const target = appending();
    field('archive').hidden = Boolean(target);
    // Hidden archive fields must not block the form with their own validation (an empty required title).
    for (const control of field('archive').querySelectorAll('input, select, textarea'))
      control.disabled = Boolean(target);
    field('song-label').hidden = !target && !isCollection(texts.title.value);
    const needs = neededVariables(
      ...TEXT_FIELDS.map(key => texts[key].value),
      field('desc_v2').value,
      field('staff').value,
      field('tags').value,
    );
    field('live-label').hidden = !needs.live;
    field('clipper-label').hidden = !needs.clipper;
    field('live-custom-label').hidden = field('live').value !== 'custom';
    field('live-date-label').hidden = !needs.date;
    field('live-title-label').hidden = !needs.title;
    for (const text of Object.values(texts)) text.refresh();
    field('title-count').textContent = `${[...texts.title.shown].length}/80`;
  }
  function write(draft) {
    for (const key of TEXT_FIELDS) texts[key].value = draft[key] ?? '';
    for (const key of [...Object.keys(ID_FIELDS), 'tid', 'copyright', 'scheduleAt'])
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
    const template = templates.find(item => String(item.id) === field('template').value);
    const draft = draftFromTemplate(template?.payload);
    if (!template) draft.tid = null;
    antiCollision = draft.includeAntiCollision;
    write(draft);
    // A song collection of this live made with the same template is where the next song goes.
    const same = collections.findIndex(item => item.template === template?.name);
    field('target').value = same >= 0 ? String(same) : 'new';
    preview();
  };
  field('copyright').onchange = () => {
    if (field('copyright').value === '2') field('no_reprint').checked = false;
  };
  host.addEventListener('input', preview);
  field('live').onchange = preview;
  field('target').onchange = preview;
  return {
    // `existing`: this live's song collections already on Bilibili, newest first.
    configure(items, schedule, name, preserve, {existing = [], song = '', recordStart = 0} = {}) {
      const selected = field('template').value;
      // Keep the chosen archive by its BV: the list may have grown or reordered since.
      const chosen = appending()?.bvid;
      start = recordStart;
      collections = existing;
      field('target').replaceChildren();
      option(field('target'), 'new', '新稿件');
      collections.forEach((item, i) => option(field('target'), String(i), `追加到《${item.title}》`));
      field('target-label').hidden = !collections.length;
      templates = items;
      field('template').replaceChildren();
      option(field('template'), '', '不使用模板');
      for (const template of templates) option(field('template'), String(template.id), template.name);
      // The template this live's collection was made with comes first among those that fit the live.
      const matched =
        matchingTemplate(
          templates.filter(template => collections.some(item => item.template === template.name)),
          schedule.matched,
        ) ?? matchingTemplate(templates, schedule.matched);
      field('template').value = preserve ? selected : matched ? String(matched.id) : '';
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
        field('live-date').value = recordDate();
        field('live-title').value = '';
        field('clipper').value = name || '';
        field('song').value = song;
        field('template').onchange();
      } else {
        const kept = collections.findIndex(item => item.bvid === chosen);
        field('target').value = kept >= 0 ? String(kept) : 'new';
      }
      preview();
    },
    // What confirming sends: one song appended to an existing collection, or a new archive.
    fields() {
      const song = field('song').value.trim();
      const target = appending();
      if (target) {
        if (!song) throw new Error('请填写歌名');
        const live = values();
        return {
          append: {mid: target.mid, bvid: target.bvid},
          title: song,
          template_variables: {
            live: live.live,
            live_date: live.live_date,
            live_title: live.live_title,
            clipper: live.clipper,
          },
        };
      }
      const draft = {};
      for (const key of TEXT_FIELDS) draft[key] = texts[key].value;
      draft.scheduleAt = field('scheduleAt').value;
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
      const collection = isCollection(draft.title);
      if (collection) {
        if (!song) throw new Error('请填写歌名');
        draft.title = titleWithSong(draft.title, song);
      }
      const live = values();
      let fields;
      try {
        fields = submissionFields(draft, live);
      } catch (error) {
        host.querySelector('details').open = true;
        throw error;
      }
      const template = templates.find(item => String(item.id) === field('template').value);
      return {
        ...fields,
        origin: {live: live.live, clipper: live.clipper, template_name: template?.name ?? '无模板'},
        parts: [{title: collection ? song : fields.title}, ...(antiCollision ? [ANTI_COLLISION] : [])],
      };
    },
  };
}
