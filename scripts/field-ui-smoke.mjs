import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browserExecutable = process.env.PLAYWRIGHT_EXECUTABLE
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const pageUrl = process.env.FIELD_UI_URL || 'http://127.0.0.1:3002';
const controlUrl = process.env.FIELD_UI_CONTROL_URL || 'http://127.0.0.1:3003';

async function waitForText(locator, text, timeout = 1_000) {
  await locator.getByText(text, { exact: false }).waitFor({ state: 'visible', timeout });
}

async function waitForProbeText(locator, pattern, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  let actual = '';
  while (Date.now() < deadline) {
    actual = (await locator.textContent()) ?? '';
    if (pattern.test(actual)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected probe value ${pattern} in ${JSON.stringify(actual)}`);
}

async function hasClass(locator, className) {
  return (await locator.getAttribute('class'))?.split(/\s+/).includes(className) ?? false;
}

const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  const card = page.locator('[aria-label="探测器1实时状态"]');
  const liveWaveform = page.locator('[aria-label="实时波形监视"]');
  const liveWaveformStatus = liveWaveform.locator('.wutos-live-waveform__status');
  const noiseDebug = page.locator('[aria-label="噪声测试完整过程"]');
  await card.waitFor({ state: 'visible', timeout: 2_000 });
  await waitForText(card, '噪声采集阶段');
  await waitForText(card, '4 点');
  await noiseDebug.waitFor({ state: 'visible', timeout: 1_000 });
  const heatBreakdown = page.locator('[aria-label="热源阶段拆分"]');
  await heatBreakdown.waitFor({ state: 'visible', timeout: 1_000 });
  for (const label of ['信号稳定阶段', '噪声采集阶段', '热源干扰采集阶段']) await waitForText(heatBreakdown, label);
  await waitForText(noiseDebug, '噪声采集进行中');
  await waitForText(noiseDebug.locator('.wutos-noise-debug__summary'), '4 / 5');
  await liveWaveform.waitFor({ state: 'visible', timeout: 1_000 });
  const liveWaveformExpand = page.getByRole('button', { name: '展开实时波形监视' });
  await liveWaveformExpand.waitFor({ state: 'visible', timeout: 1_000 });
  await liveWaveform.locator('.wutos-live-waveform__chart').waitFor({ state: 'hidden', timeout: 1_000 });
  await liveWaveformExpand.click();
  await page.getByRole('button', { name: '收起实时波形监视' }).waitFor({ state: 'visible', timeout: 1_000 });
  await waitForText(liveWaveform, '探测器 1');
  await waitForText(liveWaveform, '4 点');
  const liveWaveformValues = liveWaveform.locator('.wutos-live-waveform__values');
  await liveWaveformValues.waitFor({ state: 'visible', timeout: 1_000 });
  await waitForText(liveWaveform, '波动 / 绝对 · mV');
  await waitForProbeText(liveWaveformValues.locator('span').nth(0), /探头1\s*1\s*绝对 107/);
  await waitForProbeText(liveWaveformValues.locator('span').nth(1), /探头2\s*1\s*绝对 112/);
  await waitForProbeText(liveWaveformValues.locator('span').nth(2), /探头3\s*1\s*绝对 117/);
  await page.locator('[aria-label="探测器1实时波形"]').waitFor({ state: 'visible', timeout: 1_000 });
  await waitForText(page.locator('.wutos-stage__status'), '初始化');
  const noiseResultCard = page.locator('[aria-label="探测器1检测结果"]');
  await noiseResultCard.waitFor({ state: 'visible', timeout: 1_000 });
  assert.equal((await noiseResultCard.getAttribute('class'))?.includes('is-noise'), true, 'signal-stability result card must be highlighted');

  await page.getByRole('button', { name: '详情' }).click();
  const detailCard = page.locator('.detector-card').first();
  await waitForProbeText(detailCard.locator('.probe-metric').nth(0), /探头1\s*1\s*绝对 107/);
  await waitForProbeText(detailCard.locator('.probe-metric').nth(1), /探头2\s*1\s*绝对 112/);
  await waitForProbeText(detailCard.locator('.probe-metric').nth(2), /探头3\s*1\s*绝对 117/);
  await page.getByRole('button', { name: '通信与显示配置' }).click();
  const noiseProbeP1 = page.getByRole('checkbox', { name: '噪声分析探头 P1' });
  const noiseProbeP2 = page.getByRole('checkbox', { name: '噪声分析探头 P2' });
  const noiseProbeP3 = page.getByRole('checkbox', { name: '噪声分析探头 P3' });
  const noiseProbeP4 = page.getByRole('checkbox', { name: '噪声分析探头 P4' });
  await noiseProbeP4.click();
  assert.equal(await noiseProbeP1.isChecked(), false, 'default noise probes must start from P2/P3');
  assert.equal(await noiseProbeP2.isChecked(), true, 'adding a noise probe must keep P2 selected');
  assert.equal(await noiseProbeP3.isChecked(), true, 'adding a noise probe must keep P3 selected');
  assert.equal(await noiseProbeP4.isChecked(), true, 'the newly selected noise probe must be checked');
  await page.getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '关闭详情' }).click();

  await fetch(`${controlUrl}/control/recover?stage=STABLE`);
  await waitForText(card, '信号稳定阶段');
  await heatBreakdown.locator('[data-stage="SIGNAL_STABILIZATION"].is-active').waitFor({ state: 'visible', timeout: 1_000 });
  await waitForText(noiseDebug, '等待噪声窗口开始');
  await fetch(`${controlUrl}/control/recover?stage=NOISE`);
  await waitForText(card, '噪声采集阶段');
  await heatBreakdown.locator('[data-stage="NOISE_CAPTURE"].is-active').waitFor({ state: 'visible', timeout: 1_000 });
  await fetch(`${controlUrl}/control/recover?stage=HEAT`);
  await waitForText(card, '热源干扰采集阶段');
  await heatBreakdown.locator('[data-stage="HEAT_INTERFERENCE"].is-active').waitFor({ state: 'visible', timeout: 1_000 });
  await fetch(`${controlUrl}/control/recover?stage=FLASH`);
  await waitForText(card, '爆闪灯干扰信号采集');
  await fetch(`${controlUrl}/control/recover?stage=EMC`);
  await waitForText(card, '电磁干扰信号采集');

  const dropStartedAt = Date.now();
  await fetch(`${controlUrl}/control/drop`);
  await waitForText(card, '离线');
  await waitForText(card, '等待探测器通讯');
  await waitForText(liveWaveformStatus, '等待探测器通讯');
  const dropElapsedMs = Date.now() - dropStartedAt;
  assert.ok(dropElapsedMs < 1_000, `UI disconnect update took ${dropElapsedMs}ms`);

  const recoverStartedAt = Date.now();
  await fetch(`${controlUrl}/control/recover?stage=FLASH`);
  await waitForText(card, '爆闪灯干扰信号采集');
  await waitForText(card, '8 点');
  await waitForText(noiseDebug, '噪声采集已结束');
  await waitForText(noiseDebug, '噪声窗口结束');
  await waitForText(liveWaveform, '探测器 1');
  await waitForText(liveWaveform, '8 点');
  await waitForProbeText(liveWaveformValues.locator('span').nth(0), /探头1\s*1\s*绝对 115/);
  await waitForProbeText(liveWaveformValues.locator('span').nth(1), /探头2\s*1\s*绝对 120/);
  await waitForProbeText(liveWaveformValues.locator('span').nth(2), /探头3\s*1\s*绝对 125/);
  await waitForText(page.locator('.wutos-stage__status'), '爆闪干扰');
  assert.equal((await noiseResultCard.getAttribute('class'))?.includes('is-noise'), false, 'signal-stability highlight must end after the noise phase');
  for (const label of ['噪声测试：不合格', '移动热源干扰测试：合格', '爆闪灯干扰测试：待检测', '电磁干扰测试：待检测']) {
    await noiseResultCard.getByRole('button', { name: label }).waitFor({ state: 'visible', timeout: 1_000 });
  }
  await noiseResultCard.getByRole('button', { name: '移动热源干扰测试：合格' }).click();
  await waitForText(noiseResultCard, '1.12');
  await page.locator('[aria-label="探测器1实时波形"]').waitFor({ state: 'visible', timeout: 1_000 });
  const recoverElapsedMs = Date.now() - recoverStartedAt;
  assert.ok(recoverElapsedMs < 1_000, `UI reconnect waveform update took ${recoverElapsedMs}ms`);

  await fetch(`${controlUrl}/control/complete`);
  await waitForText(noiseDebug, '噪声采集已结束');
  const resultCard = page.locator('[aria-label="探测器1检测结果"]');
  await resultCard.waitFor({ state: 'visible', timeout: 1_000 });
  const resultPanel = page.locator('.wutos-panel--result');
  const resultTitle = resultPanel.locator('.wutos-panel__title');
  await waitForText(resultTitle, '最终结果');
  await waitForText(resultTitle, '5A类合格/0B类合格/1NG');
  const fluctuationLabelBox = await resultCard.locator('[data-noise-metric="fluctuation"] .wutos-detector-card__metric-label').boundingBox();
  const fluctuationValuesBox = await resultCard.locator('[data-noise-metric="fluctuation"] .wutos-detector-card__metric-values').boundingBox();
  assert.ok(fluctuationLabelBox && fluctuationValuesBox && fluctuationValuesBox.y >= fluctuationLabelBox.y + fluctuationLabelBox.height - 0.5, 'fluctuation label must occupy its own row');
  const absoluteLabelBox = await resultCard.locator('[data-noise-metric="absolute"] .wutos-detector-card__metric-label').boundingBox();
  const absoluteValuesBox = await resultCard.locator('[data-noise-metric="absolute"] .wutos-detector-card__metric-values').boundingBox();
  assert.ok(absoluteLabelBox && absoluteValuesBox && absoluteValuesBox.y >= absoluteLabelBox.y + absoluteLabelBox.height - 0.5, 'absolute noise label must occupy its own row');
  const fluctuationMetrics = resultCard.locator('[data-noise-metric="fluctuation"]');
  const absoluteMetrics = resultCard.locator('[data-noise-metric="absolute"]');
  await waitForProbeText(fluctuationMetrics.locator('[data-probe="probe1"]'), /P1\s*1/);
  await waitForProbeText(fluctuationMetrics.locator('[data-probe="probe2"]'), /P2\s*60/);
  await waitForProbeText(fluctuationMetrics.locator('[data-probe="probe3"]'), /P3\s*1/);
  await waitForProbeText(absoluteMetrics.locator('[data-probe="probe1"]'), /P1\s*115/);
  await waitForProbeText(absoluteMetrics.locator('[data-probe="probe2"]'), /P2\s*250/);
  await waitForProbeText(absoluteMetrics.locator('[data-probe="probe3"]'), /P3\s*125/);
  assert.equal(await hasClass(fluctuationMetrics.locator('[data-probe="probe1"] b'), 'is-over-limit'), true, 'P1 fluctuation below the lower limit must be highlighted');
  assert.equal(await hasClass(fluctuationMetrics.locator('[data-probe="probe2"] b'), 'is-over-limit'), true, 'P2 fluctuation over the limit must be highlighted');
  assert.equal(await hasClass(fluctuationMetrics.locator('[data-probe="probe3"] b'), 'is-over-limit'), true, 'P3 fluctuation below the lower limit must be highlighted');
  assert.equal(await fluctuationMetrics.locator('[data-probe="probe1"]').getAttribute('title'), '波动噪声 1，阈值 50 ~ 50');
  assert.equal(await hasClass(absoluteMetrics.locator('[data-probe="probe1"] b'), 'is-over-limit'), false, 'P1 absolute noise must stay normal');
  assert.equal(await hasClass(absoluteMetrics.locator('[data-probe="probe2"] b'), 'is-over-limit'), true, 'P2 absolute noise over the limit must be highlighted');
  assert.equal(await hasClass(absoluteMetrics.locator('[data-probe="probe3"] b'), 'is-over-limit'), false, 'P3 absolute noise must stay normal');
  assert.equal((await resultCard.textContent())?.includes('12.34'), false, 'result card must use per-probe fluctuation values');
  assert.equal((await resultCard.textContent())?.includes('456'), false, 'result card must use per-probe absolute values');
  assert.equal((await resultCard.textContent())?.includes('地址'), false, 'result card must not display detector address');
  for (const label of ['噪声测试：不合格', '移动热源干扰测试：合格', '爆闪灯干扰测试：不合格', '电磁干扰测试：合格']) {
    await resultCard.getByRole('button', { name: label }).waitFor({ state: 'visible', timeout: 1_000 });
  }
  await resultCard.getByRole('button', { name: '噪声测试：不合格' }).click();
  const noisePopover = resultCard.locator('.wutos-process-lamp__popover');
  await waitForText(noisePopover, '各探头噪声值');
  await waitForText(noisePopover, '波动 P1:1 / P2:60 / P3:1');
  await waitForText(noisePopover, '绝对 P1:115 / P2:250 / P3:125');
  assert.equal((await resultCard.textContent())?.includes('最大探头比值'), false, 'noise test popover must not show probe ratios');
  await resultCard.getByRole('button', { name: '爆闪灯干扰测试：不合格' }).click();
  await waitForText(resultCard, 'P2/P3 最大值');
  await waitForText(resultCard, '1.80');
  await waitForText(resultCard, '不合格原因：爆闪灯干扰测试 P2/P3 信噪比高于上限');

  assert.deepEqual(pageErrors, [], `unexpected browser page errors: ${pageErrors.join('; ')}`);
  console.log(JSON.stringify({ ok: true, dropElapsedMs, recoverElapsedMs }));
} finally {
  await browser.close();
}
