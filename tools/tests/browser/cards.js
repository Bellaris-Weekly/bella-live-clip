// Runs against the full application, including asynchronous schedule enrichment.
export async function runCardChecks(app, query, preloadProbe) {
  const result = document.getElementById('result'),
    root = app.root;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const until = async condition => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('等待界面超时');
  };
  const back = () => root.querySelector('[aria-label="返回场次列表"]');
  const checks = [];
  try {
    await until(() => root.querySelectorAll('.record').length === 6 && !root.getElementById('refreshLibrary').disabled);
    if (query.has('preload')) {
      assert(preloadProbe.historyCalls > 0, '打开面板后没有加载列表');
      assert(preloadProbe.historyCalls === 1, '打开面板重复请求了直播列表');
      checks.push('打开面板前已预加载且复用同一列表请求');
    }
    await until(() =>
      query.has('schedule-error')
        ? root.querySelector('#library .notice')?.textContent.includes('暂不可用')
        : root.querySelectorAll('.record .badge').length === 5,
    );
    const cards = [...root.querySelectorAll('.record')];
    assert(!root.querySelector('.cover'), '仍然显示封面');
    assert(cards[0].querySelector('.record-title').textContent === '【3D】今晚一起唱歌', '原标题被替换');
    assert(
      cards.every(
        (c, i) =>
          c.querySelector('.record-meta > span:nth-of-type(2)').textContent ===
          (query.has('live-library') && i === 0 ? '直播中' : query.has('timeline') ? '01:22:56' : '00:00:24'),
      ),
      '没有使用实际时长',
    );
    assert(
      cards.every(c => !/贝拉|嘉然|乃琳/.test(c.textContent)),
      '卡片出现姓名文字',
    );
    assert(!cards[5].querySelector('.badge') && !cards[5].querySelector('.person'), '无日程时猜测了参与者');
    assert(
      cards.every(c => c.scrollWidth <= c.clientWidth),
      '卡片横向溢出',
    );
    // The list is a single column of full-width rows at every panel width.
    const list = root.querySelector('.records').getBoundingClientRect();
    assert(
      cards.every(c => {
        const box = c.getBoundingClientRect();
        return Math.abs(box.left - list.left) < 1 && Math.abs(box.right - list.right) < 1;
      }) && new Set(cards.map(c => Math.round(c.getBoundingClientRect().top))).size === cards.length,
      '场次行没有单列铺满',
    );
    assert(cards[0].querySelector('.record-date').textContent === '129月', '日期块北京时间错误');
    assert(cards[0].querySelector('.record-meta > span').textContent === '周六 19:36', '时间北京时间错误');
    checks.push('无封面、原标题、无可见姓名、实际时长、未匹配回退、布局无溢出');
    if (!query.has('schedule-error')) {
      assert(cards[0].querySelectorAll('.person').length === 3, '团播头像数量错误');
      assert(cards[3].querySelectorAll('.person').length === 2, '双播头像数量错误');
      assert(cards[2].querySelectorAll('.person').length === 1, '单播头像数量错误');
      checks.push('团播、双播、单播头像数量');
    }
    root.querySelector('[data-member="xinyi"]').click();
    await until(
      () =>
        root.querySelector('[data-member="xinyi"]').getAttribute('aria-pressed') === 'true' &&
        !root.getElementById('refreshLibrary').disabled,
    );
    assert(!root.querySelector('.badge') && !root.querySelector('.person'), '其他成员残留日程');
    checks.push('切换成员无日程串场');
    if (query.has('slow-schedule')) {
      root.querySelector('[data-member="bella"]').click();
      await until(() => !root.getElementById('refreshLibrary').disabled);
      root.getElementById('refreshLibrary').click();
      await until(() => !root.getElementById('refreshLibrary').disabled);
      root.querySelector('[data-member="sinuo"]').click();
      await new Promise(resolve => setTimeout(resolve, 1300));
      assert(
        root.querySelector('[data-member="sinuo"]').getAttribute('aria-pressed') === 'true' &&
          !root.querySelector('.badge'),
        '迟到的日程污染当前成员',
      );
      checks.push('日程加载中切换成员取消旧请求');
    }
    root.querySelector('[data-member="bella"]').click();
    await until(() => !root.getElementById('refreshLibrary').disabled);
    if (query.has('slow-schedule')) {
      root.getElementById('refreshLibrary').click();
      await until(() => !root.getElementById('refreshLibrary').disabled);
    }
    root.querySelector('.record').click();
    await until(() => !root.getElementById('editPage').hidden && !back().disabled);
    if (query.has('slow-schedule')) await new Promise(resolve => setTimeout(resolve, 1300));
    assert(root.getElementById('recordTitle').textContent === '【3D】今晚一起唱歌', '进入录像后标题改变');
    assert(!root.getElementById('editPage').hidden, '迟到日程打断了录像页');
    assert(Number(root.getElementById('startHandle').getAttribute('aria-valuenow')) === 0, '默认选区起点错误');
    assert(
      Number(root.getElementById('endHandle').getAttribute('aria-valuenow')) === (query.has('timeline') ? 4976 : 24),
      '默认选区未覆盖整场',
    );
    const durationNode = root.getElementById('selectionDuration'),
      sizeNode = root.getElementById('estimatedSize');
    assert(!/选中|预估/.test(durationNode.textContent + sizeNode.textContent), '摘要仍有多余前缀');
    assert(durationNode.closest('.timeline-card') && sizeNode.closest('.dock'), '时长与大小位置错误');
    assert(
      root
        .getElementById('wholeRecording')
        .closest('.timeline-top')
        .firstElementChild.contains(root.getElementById('wholeRecording')),
      '整场开关未移到左侧',
    );
    assert(root.getElementById('timelineZoom').textContent.endsWith('×'), '时间轴倍率未显示');
    checks.push('默认整场选区与时间轴摘要布局');
    if (!query.has('schedule-error')) await until(() => root.querySelector('.head-meta').textContent.endsWith('团播'));
    assert(!/历史回放|本场直播/.test(root.querySelector('.head-meta').textContent), '场次信息仍显示来源标签');
    // The picker is re-rendered when it comes back from whole mode, so look the buttons up each time.
    const mode = name => root.querySelector(`[data-mode="${name}"]`);
    mode('precise').click();
    assert(
      mode('precise').getAttribute('aria-pressed') === 'true' && mode('copy').getAttribute('aria-pressed') === 'false',
      '精确模式切换失败',
    );
    assert(!sizeNode.textContent.includes('原画参考'), '精确模式仍显示原画参考');
    root.getElementById('wholeRecording').click();
    assert(!root.getElementById('exportMode'), '整场模式未隐藏切换');
    root.getElementById('wholeRecording').click();
    assert(
      root.getElementById('exportMode') && mode('precise').getAttribute('aria-pressed') === 'true',
      '退出整场后模式丢失',
    );
    mode('copy').click();
    assert(mode('copy').getAttribute('aria-pressed') === 'true', '原画模式切换失败');
    assert(!root.querySelector('select#exportMode'), '旧导出下拉框仍存在');
    checks.push('直播类型、双选项切换和整场模式恢复');
    back().click();
    await until(() => !root.getElementById('library').hidden && !root.getElementById('refreshLibrary').disabled);
    checks.push('选择录像与返回列表');
    result.textContent = '通过：' + checks.join('；');
    await fetch(
      '/artifact/cards-browser-results' +
        (query.has('narrow') ? '-narrow' : '') +
        (query.has('schedule-error') ? '-fallback' : '') +
        (query.has('slow-schedule') ? '-race' : '') +
        '.json',
      {method: 'POST', body: JSON.stringify({passed: true, checks})},
    );
  } catch (error) {
    result.textContent = '失败：' + error.message;
  }
}
