import http from 'node:http';
import { createRequire } from 'node:module';

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocketServer } = requireFromServer('ws');

const port = Number(process.env.FIELD_UI_MOCK_PORT || 3003);
const clients = new Set();
let online = true;
let stageCode = 1;
let stepCode = 1;
let phase = 'NOISE';
let processStage = 'INIT';
let sampleCount = 4;
let completed = false;
let noiseCaptureActive = true;
let heatSubstage = 'NOISE_CAPTURE';

const heatSubstageLabels = {
  IDLE: '非热源阶段',
  POSITIONING: '热源定位/阶段过渡',
  SIGNAL_STABILIZATION: '信号稳定阶段',
  NOISE_CAPTURE: '噪声采集阶段',
  HEAT_INTERFERENCE: '热源干扰采集阶段',
};

function samples(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    probe1: 100 + offset + index,
    probe2: 105 + offset + index,
    probe3: 110 + offset + index,
  }));
}

function stageLabel() {
  if (processStage === 'INIT') return '初始化';
  if (processStage === 'HEAT') return '移动热源';
  if (processStage === 'FLASH') return '爆闪干扰';
  if (processStage === 'EMC') return '电磁干扰';
  if (processStage === 'RETURN_HOME') return '回初始位确认';
  return '未知工序码';
}

function makePLCStatus() {
  const timestamp = Date.now();
  return {
    stageCode,
    stepCode,
    autoRunning: !completed,
    complete: completed,
    alarm: false,
    returningHome: false,
    timestamp,
    stage: processStage,
    label: stageLabel(),
    processStage,
    processLabel: stageLabel(),
    heatSubstage,
    heatSubstageLabel: heatSubstageLabels[heatSubstage],
    valid: true,
    io: {
      inputs: { safetyInput: true },
      outputs: {},
      internal: { autoRunning: !completed, complete: completed, processAlarm: false, safetyOk: true, signalStabilizing: heatSubstage === 'SIGNAL_STABILIZATION', noiseCaptureWindow: noiseCaptureActive && phase === 'NOISE' },
      steps: { stepM10_4: heatSubstage === 'HEAT_INTERFERENCE' },
      syncedAt: timestamp,
    },
  };
}

function makeUnit(index, active) {
  const unitSamples = active ? samples(sampleCount, sampleCount) : [];
  const completedNoiseMetrics = completed && index === 1
    ? { probe2Fluctuation: 60, probe2Absolute: 250 }
    : {};
  return {
    index,
    address: 1,
    online: active,
    fire: false,
    fault: false,
    sourceReady: active,
    syncOk: active,
    probe1: active ? 1 : 0,
    probe2: active ? 1 : 0,
    probe3: active ? 1 : 0,
    snr21: 1,
    snr23: 1,
    snr31: 1,
    sensitivity: 1,
    sendMode: active ? 1 : 0,
    version: 'ui-simulator',
    address_r: 1,
    runTime: 0,
    probeCount: 3,
    protocol: 'standard',
    features: [],
    samples: unitSamples,
    rawSamples: unitSamples,
    historySamples: unitSamples,
    rawHistorySamples: unitSamples,
    historySampleTotal: unitSamples.length,
    lastUpdate: Date.now(),
    ...completedNoiseMetrics,
  };
}

function makeState() {
  const units = Array.from({ length: 6 }, (_, offset) => makeUnit(offset + 1, offset === 0 && online));
  return {
    units,
    onlineCount: online ? 1 : 0,
    fireCount: 0,
    faultCount: 0,
    timestamp: Date.now(),
  };
}

function makeAnalysis() {
  const now = Date.now();
  const stabilizationStartedAt = now - 65_000;
  const stabilizationEndedAt = heatSubstage === 'SIGNAL_STABILIZATION' ? null : now - 35_000;
  const noiseStartedAt = heatSubstage === 'SIGNAL_STABILIZATION' ? null : now - 35_000;
  const noiseEndedAt = heatSubstage === 'NOISE_CAPTURE' ? null : heatSubstage === 'SIGNAL_STABILIZATION' ? null : now - 5_000;
  const interferenceStartedAt = heatSubstage === 'HEAT_INTERFERENCE'
    ? now - 900
    : heatSubstage === 'IDLE' && (processStage === 'FLASH' || processStage === 'EMC' || completed) ? now - 6_000 : null;
  const interferenceEndedAt = heatSubstage === 'HEAT_INTERFERENCE' ? null : interferenceStartedAt === null ? null : now - 900;
  const heatCompleted = completed || processStage === 'FLASH' || processStage === 'EMC' || processStage === 'RETURN_HOME';
  const flashCompleted = completed || processStage === 'EMC' || processStage === 'RETURN_HOME';
  const emcCompleted = completed;
  return {
    batchId: 'ui-simulator-batch',
    phase,
    processStage,
    verdict: completed ? 'FAIL' : 'PENDING',
    startedAt: now - 1_000,
    noiseCaptureActive: noiseCaptureActive && phase === 'NOISE',
    heatSubstage,
    heatSubstageLabel: heatSubstageLabels[heatSubstage],
    heatStageTimings: {
      stabilizationStartedAt,
      stabilizationEndedAt,
      noiseStartedAt,
      noiseEndedAt,
      interferenceStartedAt,
      interferenceEndedAt,
    },
    noiseStartedAt,
    noiseEndedAt,
    updatedAt: now,
    thresholds: {
      minNoiseSamples: 5,
      minInterferenceSamples: 5,
      minNoiseRms: 50,
      maxNoiseRms: 50,
      maxInterferenceRatio: 10,
      quality: {
        acceptanceGrade: 'B',
        a: { maxNoiseRms: 40, maxNoiseAbsolute: 200, maxInterferenceRatio: 10, minConsistencyTrend: 0, minSensitivity: 0 },
        b: { maxNoiseRms: 50, maxNoiseAbsolute: 200, maxInterferenceRatio: 10, minConsistencyTrend: 0, minSensitivity: 0 },
        ratios: {
          a: { snr21: { min: 0, max: 0 }, snr23: { min: 0.5, max: 1.5 }, snr31: { min: 0, max: 0 } },
          b: { snr21: { min: 0, max: 0 }, snr23: { min: 0.48, max: 1.5 }, snr31: { min: 0, max: 0 } },
        },
      },
    },
    units: Array.from({ length: 6 }, (_, offset) => ({
      index: offset + 1,
      address: 1,
      phase,
      verdict: completed ? (offset === 0 ? 'FAIL' : 'PASS') : 'PENDING',
      noiseRms: 12.34,
      noisePeakToPeak: null,
      noiseAbsolute: 456,
      interferenceRms: null,
      interferenceRatio: null,
      noiseSampleCount: phase === 'INTERFERENCE' ? 5 : sampleCount,
      interferenceSampleCount: phase === 'INTERFERENCE' ? sampleCount : 0,
      noiseTest: {
        verdict: phase === 'NOISE' ? 'PENDING' : 'FAIL',
        reason: phase === 'NOISE' ? 'WAITING_FOR_NOISE_WINDOW_COMPLETE' : 'NOISE_RMS_BELOW_LIMIT',
        sampleCount: phase === 'INTERFERENCE' ? 5 : sampleCount,
        metrics: {
          probe1: { fluctuation: 1, absolute: 115 },
          probe2: { fluctuation: offset === 0 ? 60 : 1, absolute: offset === 0 ? 250 : 120 },
          probe3: { fluctuation: 1, absolute: 125 },
          probe4: { fluctuation: 0, absolute: 0 },
        },
      },
      sampledAt: Date.now(),
      stages: {
        heat: { completed: heatCompleted, verdict: heatCompleted ? 'PASS' : 'PENDING', reason: heatCompleted ? 'STAGE_WITHIN_LIMIT' : 'WAITING_FOR_PROCESS_COMPLETE', sampleCount: 8, interferenceRatio: 1.12, consistencyTrend: 0.91, snr21: 1.02, snr23: 1.12, snr31: 0.98 },
        flash: { completed: flashCompleted, verdict: flashCompleted && offset === 0 ? 'FAIL' : flashCompleted ? 'PASS' : 'PENDING', reason: flashCompleted && offset === 0 ? 'SNR23_ABOVE_LIMIT' : flashCompleted ? 'STAGE_WITHIN_LIMIT' : 'WAITING_FOR_PROCESS_COMPLETE', sampleCount: 8, interferenceRatio: 1.8, consistencyTrend: 0.88, snr21: 2.4, snr23: 1.8, snr31: 2.1 },
        emc: { completed: emcCompleted, verdict: emcCompleted ? 'PASS' : 'PENDING', reason: emcCompleted ? 'STAGE_WITHIN_LIMIT' : 'WAITING_FOR_PROCESS_COMPLETE', sampleCount: 8, interferenceRatio: 1.2, consistencyTrend: 0.9, snr21: 1.05, snr23: 1.2, snr31: 0.95 },
      },
      reason: completed && offset === 0 ? 'FLASH_SNR23_ABOVE_LIMIT' : online ? 'WAITING_FOR_PROCESS_COMPLETE' : 'DETECTOR_OFFLINE',
    })),
  };
}

function makeSummary() {
  const process = makePLCStatus();
  const state = makeState();
  const waveformAnalysis = makeAnalysis();
  return {
    process,
    plcConnected: true,
    detectorConnected: online,
    detectorTransportConnected: online,
    detectorDataStreamConnected: online,
    detectorVerdict: {
      verdict: completed ? 'FAIL' : 'PENDING',
      grade: completed ? 'FAIL' : 'PENDING',
      units: state.units.map((unit) => ({
        index: unit.index,
        address: unit.address,
        verdict: completed ? (unit.index === 1 ? 'FAIL' : 'PASS') : 'PENDING',
        grade: completed ? (unit.index === 1 ? 'FAIL' : 'A_PASS') : 'PENDING',
        reason: completed ? (unit.index === 1 ? 'FLASH_SNR23_ABOVE_LIMIT' : 'ALL_STAGES_A_GRADE_WITHIN_LIMIT') : online ? '等待定量指标' : '通信未连接',
        sampledAt: unit.lastUpdate,
        metrics: { noiseRms: 12.34, noiseAbsolute: 456, snr21: 2.5, snr23: unit.index === 1 ? 1.8 : 1.1, snr31: 2.2 },
      })),
    },
    waveformAnalysis,
    finalVerdict: completed ? { verdict: 'FAIL', grade: 'FAIL' } : { verdict: 'PENDING', reason: 'WAITING_FOR_PROCESS_COMPLETE' },
  };
}

const detectorConfig = {
  mode: 'TCP',
  ip: '127.0.0.1',
  port: 39999,
  waveformSendMode: 'active',
  waveformDisplayMode: 'normalized',
  waveformMaxSamples: 1000,
  units: Array.from({ length: 6 }, (_, offset) => ({
    index: offset + 1,
    address: 1,
    enabled: offset === 0,
    connMode: 'TCP',
    tcpHost: '127.0.0.1',
    tcpPort: 39999,
  })),
};

const plcSystemConfig = {
  lastUpdated: Date.now(),
  steps: [
    { id: 's1', name: '开始测试', duration: 2, waitTime: 0 },
    { id: 's2', name: '电机运转', duration: 4, waitTime: 0 },
    { id: 's3', name: '识别到达检测位', duration: 3, waitTime: 1 },
    { id: 's4', name: '火焰响应测试', duration: 10, waitTime: 2 },
    { id: 's5', name: '检测报警信号', duration: 5, waitTime: 0 },
    { id: 's6', name: '电机复位', duration: 3, waitTime: 0 },
    { id: 's7', name: '检测是否继续', duration: 2, waitTime: 0 },
    { id: 's8', name: '结束测试', duration: 3, waitTime: 0 },
  ],
};

function json(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function send(ws, type, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
}

function broadcast() {
  const state = makeState();
  const summary = makeSummary();
  for (const ws of clients) {
    send(ws, 'flame_state', state);
    send(ws, 'plc_process_status', summary.process);
    send(ws, 'field_summary', summary);
  }
}

function setStage(nextStage) {
  completed = false;
  if (nextStage === 'STABLE') {
    stageCode = 1;
    stepCode = 1;
    phase = 'NOISE';
    processStage = 'INIT';
    noiseCaptureActive = false;
    heatSubstage = 'SIGNAL_STABILIZATION';
  } else if (nextStage === 'NOISE') {
    stageCode = 2;
    stepCode = 3;
    phase = 'NOISE';
    processStage = 'HEAT';
    noiseCaptureActive = true;
    heatSubstage = 'NOISE_CAPTURE';
  } else if (nextStage === 'HEAT') {
    stageCode = 2;
    stepCode = 3;
    phase = 'INTERFERENCE';
    processStage = 'HEAT';
    noiseCaptureActive = false;
    heatSubstage = 'HEAT_INTERFERENCE';
  } else if (nextStage === 'FLASH') {
    stageCode = 3;
    stepCode = 3;
    phase = 'INTERFERENCE';
    processStage = 'FLASH';
    noiseCaptureActive = false;
    heatSubstage = 'IDLE';
  } else if (nextStage === 'EMC') {
    stageCode = 4;
    stepCode = 3;
    phase = 'INTERFERENCE';
    processStage = 'EMC';
    noiseCaptureActive = false;
    heatSubstage = 'IDLE';
  } else {
    stageCode = 1;
    stepCode = 1;
    phase = 'NOISE';
    processStage = 'INIT';
    noiseCaptureActive = true;
    heatSubstage = 'NOISE_CAPTURE';
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' });
    res.end();
    return;
  }
  if (url.pathname === '/api/health') return json(res, 200, { status: 'ok', detectorDataStreamConnected: online });
  if (url.pathname === '/api/field/summary') return json(res, 200, makeSummary());
  if (url.pathname === '/api/flame/devices') return json(res, 200, makeState());
  if (url.pathname === '/api/flame/config') return json(res, 200, { success: true, config: detectorConfig });
  if (url.pathname === '/api/system-config') return json(res, 200, { success: true, config: plcSystemConfig });
  if (url.pathname === '/control/drop') {
    online = false;
    broadcast();
    return json(res, 200, { ok: true, online });
  }
  if (url.pathname === '/control/recover') {
    online = true;
    sampleCount = 8;
    setStage(url.searchParams.get('stage') || 'FLASH');
    broadcast();
    return json(res, 200, { ok: true, online, processStage });
  }
  if (url.pathname === '/control/complete') {
    completed = true;
    phase = 'COMPLETE';
    processStage = 'COMPLETE';
    noiseCaptureActive = false;
    heatSubstage = 'IDLE';
    broadcast();
    return json(res, 200, { ok: true, completed });
  }
  return json(res, 404, { code: 'NOT_FOUND' });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  clients.add(ws);
  send(ws, 'connection_status', { message: '连接成功' });
  const state = makeState();
  const summary = makeSummary();
  send(ws, 'flame_state', state);
  send(ws, 'plc_process_status', summary.process);
  send(ws, 'field_summary', summary);
  ws.on('close', () => clients.delete(ws));
});

server.listen(port, '127.0.0.1', () => console.log(`FIELD_UI_MOCK_READY:${port}`));

function stop() {
  for (const ws of clients) ws.close();
  wss.close();
  server.close(() => process.exit(0));
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
