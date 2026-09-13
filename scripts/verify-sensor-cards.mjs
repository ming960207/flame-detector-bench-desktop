// 使用 pwcli -s=sensor-layout run-code --filename scripts/verify-sensor-cards.mjs 执行。
// 所有后端请求与 WebSocket 均在浏览器内模拟，不连接现场设备。
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const sockets = new Set();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 仅允许 Vite 热更新连接；打印服务等旁路也必须隔离。
  await page.routeWebSocket(url => !String(url).startsWith('ws://127.0.0.1:3002/'), () => {});
  await page.routeWebSocket('ws://127.0.0.1:3001/**', socket => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
  });
  const samples = Array.from({ length: 64 }, (_, index) => ({
    probe1: 110 + 40 * Math.sin(index / 4),
    probe2: 280 + 80 * Math.sin(index / 5),
    probe3: 190 + 55 * Math.cos(index / 6),
    probe4: 230 + 70 * Math.cos(index / 7),
  }));
  const units = Array.from({ length: 6 }, (_, index) => ({
    index: index + 1, address: index + 1, online: true, fire: false, fault: false,
    probeCount: 3, probe1: 12345, probe2: 23456, probe3: 12345,
    probe1Fluctuation: 12345, probe2Fluctuation: 23456, probe3Fluctuation: 12345,
    probe1Absolute: 65535, probe2Absolute: 54321, probe3Absolute: 43210,
    snr23: 1.9, lastUpdate: Date.now(), historySamples: samples,
    rawHistorySamples: samples.map(sample => Object.fromEntries(Object.entries(sample).map(([key, value]) => [key, value + 2000]))),
  }));
  const state = { units, onlineCount: 6, fireCount: 0, faultCount: 0, timestamp: Date.now() };
  let mode = 'normalized';
  await page.route('**/api/**', async route => {
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const payload = path === '/api/flame/devices' ? state
      : path === '/api/flame/config' ? { config: { waveformDisplayMode: mode, waveformMaxSamples: 1000 } }
      : path === '/api/field/summary' ? { finalVerdict: null }
      : { jobs: [], units: [] };
    await route.fulfill({ json: payload });
  });
  const send = (type, payload) => {
    check(sockets.size > 0, '模拟 WebSocket 未连接');
    for (const socket of sockets) socket.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
  };
  await page.setViewportSize({ width: 1920, height: 1080 });
  // 主屏会持续轮询状态，使用实际波形和字体就绪作为渲染完成条件。
  await page.goto('http://127.0.0.1:3002/', { waitUntil: 'domcontentloaded' });
  await page.locator('.wutos-sensor-wave svg').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: '.playwright-cli/sensor-layout-current.png' });
  const first = page.locator('.wutos-sensor-card').first();
  check(await page.locator('.wutos-sensor-card').count() === 6, '必须保留 6 张实时卡片');
  check(await first.locator('.wutos-sensor-values--ratios > span').count() === 1, '探头比值必须仅保留 P2/P3');
  check(!/P2\/P1|P3\/P1|噪声|RMS|干扰比|样本/.test(await first.innerText()), '实时卡片包含已删除的指标');
  check((await first.locator('.wutos-sensor-values--ratios').innerText()).includes('P2/P3'), '缺少 P2/P3');

  const inspectLayout = () => page.evaluate(() => {
    const rect = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height, right: x + width, bottom: y + height };
    };
    const overlaps = (a, b) => a.x < b.right - .5 && a.right > b.x + .5 && a.y < b.bottom - .5 && a.bottom > b.y + .5;
    const cards = [...document.querySelectorAll('.wutos-sensor-card')];
    const bounds = cards.map(rect);
    const stage = rect(document.querySelector('.wutos-stage'));
    const machine = document.querySelector('.wutos-machine');
    const machineBox = rect(machine);
    const imageScale = Math.min(machineBox.width / machine.naturalWidth, machineBox.height / machine.naturalHeight);
    const paintedMachine = {
      x: machineBox.x + (machineBox.width - machine.naturalWidth * imageScale) / 2,
      y: machineBox.y + (machineBox.height - machine.naturalHeight * imageScale) / 2,
      right: machineBox.right - (machineBox.width - machine.naturalWidth * imageScale) / 2,
      bottom: machineBox.bottom - (machineBox.height - machine.naturalHeight * imageScale) / 2,
    };
    const problems = [];
    cards.forEach((card, index) => {
      const box = bounds[index];
      if (box.x < stage.x || box.right > stage.right || box.y < stage.y || box.bottom > stage.bottom) problems.push(`卡片 ${index + 1} 越界`);
      if (overlaps(box, paintedMachine)) problems.push(`卡片 ${index + 1} 遮挡设备图片`);
      if (overlaps(box, rect(document.querySelector('.wutos-live-waveform')))) problems.push(`卡片 ${index + 1} 遮挡独立波形面板`);
      if (overlaps(box, rect(document.querySelector('.wutos-stage__status')))) problems.push(`卡片 ${index + 1} 遮挡工序状态`);
      for (const panel of document.querySelectorAll('.wutos-panel')) {
        if (overlaps(box, rect(panel))) problems.push(`卡片 ${index + 1} 与外围面板重叠`);
      }
      bounds.slice(index + 1).forEach(other => { if (overlaps(box, other)) problems.push('卡片相互遮挡'); });
      for (const element of card.querySelectorAll('header, header b, header small, .wutos-sensor-values, .wutos-sensor-values > span, .wutos-sensor-values b, .wutos-sensor-values small, footer')) {
        const child = rect(element);
        if (element.scrollWidth > element.clientWidth + 1 || child.x < box.x || child.right > box.right + 1 || child.bottom > box.bottom + 1) problems.push(`卡片 ${index + 1} 内容溢出：${element.textContent}`);
      }
      const wave = rect(card.querySelector('.wutos-sensor-wave'));
      if (wave.height < 38 || wave.width < 70) problems.push(`卡片 ${index + 1} 波形空间不足`);
      const probe = card.querySelector('.wutos-sensor-values--probes b');
      const ratio = card.querySelector('.wutos-sensor-values--ratios b');
      if (parseFloat(getComputedStyle(ratio).fontSize) > parseFloat(getComputedStyle(probe).fontSize) * 1.15) problems.push('比值字号不均衡');
    });
    return { problems, card: bounds[0], wave: rect(cards[0].querySelector('.wutos-sensor-wave')), machine: machineBox };
  });
  const measurements = [];
  for (const [width, height] of [[1920, 1080], [1280, 1080], [1440, 900], [1366, 768]]) {
    await page.setViewportSize({ width, height });
    const result = await inspectLayout();
    measurements.push({ width, height, ...result });
    await page.screenshot({ path: `.playwright-cli/sensor-layout-${width}x${height}.png` });
    if (width === 1920) await first.screenshot({ path: '.playwright-cli/sensor-card-detail.png' });
    check(result.problems.length === 0, `${width}×${height}: ${result.problems.join('; ')}`);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  const paths = () => page.locator('.wutos-sensor-wave .wutos-wave-line').evaluateAll(elements => elements.map(element => element.getAttribute('d')));
  const beforePaths = await paths();
  check(beforePaths.length === 18, '三探头必须保留每卡 3 条曲线');
  send('flame_waveform_delta', {
    ...state,
    units: units.map(unit => ({ ...unit, historySamples: undefined, rawHistorySamples: undefined,
      historyDelta: [{ probe1: 987, probe2: 876, probe3: 765 }],
      rawHistoryDelta: [{ probe1: 3987, probe2: 3876, probe3: 3765 }],
    })),
  });
  await page.waitForFunction(previous => [...document.querySelectorAll('.wutos-sensor-wave .wutos-wave-line')].every((element, index) => element.getAttribute('d') !== previous[index]), beforePaths);
  check((await first.locator('.wutos-sensor-caption').innerText()).includes('65 点'), '波形增量未追加');
  await page.getByRole('button', { name: '展开实时波形监视' }).click();
  await page.getByRole('button', { name: '查看探测器6波形' }).click();
  check(await page.getByRole('img', { name: '探测器6实时波形监视', exact: true }).isVisible(), '独立波形面板切换失败');
  const expanded = await inspectLayout();
  check(expanded.problems.length === 0, expanded.problems.join('; '));
  await page.getByRole('button', { name: '收起实时波形监视' }).click();
  mode = 'raw';
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wutos-sensor-caption').textContent.includes('原始值'));
  check((await paths()).length === 18, '原始值模式曲线丢失');
  for (const probeCount of [2, 4]) {
    send('flame_state', { ...state, units: units.map(unit => ({ ...unit, probeCount, probe4: 34567, probe4Fluctuation: 34567, probe4Absolute: 65535 })) });
    await page.waitForFunction(count => document.querySelector('.wutos-sensor-values--probes').children.length === count, probeCount);
    for (const [width, height] of [[1280, 1080], [1366, 768]]) {
      await page.setViewportSize({ width, height });
      const result = await inspectLayout();
      check(result.problems.length === 0, `${probeCount} 探头 ${width}×${height}: ${result.problems.join('; ')}`);
    }
    check((await paths()).length === 6 * probeCount, `${probeCount} 探头曲线数量不正确`);
  }
  send('flame_state', { ...state, onlineCount: 0, units: units.map(unit => ({ ...unit, online: false, historySamples: [], rawHistorySamples: [], startup: { state: 'MODE_SWITCH_OK' } })) });
  await page.waitForFunction(() => document.querySelectorAll('.wutos-sensor-wave > span').length === 6);
  check((await inspectLayout()).problems.length === 0, '等待状态布局溢出');
  send('flame_state', state);
  await page.locator('.wutos-sensor-wave svg').first().waitFor();
  check((await paths()).length === 18, '重新收到数据后波形未恢复');
  check(errors.length === 0, errors.join('\n'));
  await page.goto('about:blank');
  return { passed: true, measurements, checks: ['单一 P2/P3', '长数值完整显示', '6 卡不遮挡', '波形增量更新', '原始值模式', '独立波形切换', '2/3/4 探头', '断流恢复'] };
}
