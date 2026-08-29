import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { WSServer } from '../dist/websocket/ws-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function waitForMessage(messages, predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const message = messages.find(predicate);
      if (message) {
        resolve(message);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('等待 WebSocket 消息超时'));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

test('实时波形保留 1000 点，后续 WebSocket 只发送增量采样', async () => {
  const httpServer = createServer();
  const wsServer = new WSServer();
  wsServer.init(httpServer);
  const port = await listen(httpServer);
  const history = Array.from({ length: 1_000 }, (_, index) => ({
    probe1: index,
    probe2: index + 1,
    probe3: index + 2,
  }));
  const state = {
    timestamp: 1,
    onlineCount: 1,
    fireCount: 0,
    faultCount: 0,
    units: [{
      index: 1,
      historySamples: history,
      rawHistorySamples: history,
      historySampleTotal: history.length,
    }],
  };
  wsServer.on('client_connected', (serverClient) => wsServer.sendFlameState(serverClient, state));
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  client.on('message', (data) => messages.push(JSON.parse(data.toString())));

  try {
    await once(client, 'open');
    const fullMessage = await waitForMessage(messages, (message) => message.type === 'flame_state');

    const payload = fullMessage.payload;
    assert.equal(payload.units[0].historySamples.length, 1_000);
    assert.equal(payload.units[0].rawHistorySamples.length, 1_000);

    const nextSample = { probe1: 1_000, probe2: 1_001, probe3: 1_002 };
    const nextHistory = [...history, nextSample];
    wsServer.broadcastFlameState({
      ...state,
      timestamp: state.timestamp + 1,
      units: [{
        ...state.units[0],
        historySamples: nextHistory,
        rawHistorySamples: nextHistory,
        historySampleTotal: nextHistory.length,
      }],
    });
    const deltaMessage = await waitForMessage(messages, (message) => message.type === 'flame_waveform_delta');
    assert.deepEqual(deltaMessage.payload.units[0].historyDelta, [nextSample]);
    assert.deepEqual(deltaMessage.payload.units[0].rawHistoryDelta, [nextSample]);
    assert.equal('historySamples' in deltaMessage.payload.units[0], false);
    assert.equal('rawHistorySamples' in deltaMessage.payload.units[0], false);
    assert.equal(state.units[0].historySamples.length, history.length, '广播不应修改服务端历史');
  } finally {
    client.close();
    wsServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('高频波形更新合并后发布，不在网页消息队列堆积', async () => {
  const httpServer = createServer();
  const wsServer = new WSServer();
  wsServer.init(httpServer);
  const port = await listen(httpServer);
  const initialSample = { probe1: 0, probe2: 1, probe3: 2 };
  const initialState = {
    timestamp: 1,
    onlineCount: 1,
    fireCount: 0,
    faultCount: 0,
    units: [{
      index: 1,
      historySamples: [initialSample],
      rawHistorySamples: [initialSample],
      historySampleTotal: 1,
    }],
  };
  wsServer.on('client_connected', (serverClient) => wsServer.sendFlameState(serverClient, initialState));
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  client.on('message', (data) => messages.push(JSON.parse(data.toString())));

  try {
    await once(client, 'open');
    await waitForMessage(messages, (message) => message.type === 'flame_state');
    messages.length = 0;

    const history = [initialSample];
    for (let index = 1; index <= 40; index += 1) {
      history.push({ probe1: index, probe2: index + 1, probe3: index + 2 });
      wsServer.broadcastFlameState({
        ...initialState,
        timestamp: index + 1,
        units: [{
          ...initialState.units[0],
          historySamples: [...history],
          rawHistorySamples: [...history],
          historySampleTotal: history.length,
        }],
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 260));
    const waveformMessages = messages.filter((message) => (
      message.type === 'flame_state' || message.type === 'flame_waveform_delta'
    ));
    assert.ok(waveformMessages.length <= 2, `260ms 内不应发布 ${waveformMessages.length} 个波形消息`);
    const delivered = waveformMessages.flatMap((message) => (
      message.type === 'flame_state'
        ? message.payload.units[0].historySamples.slice(1)
        : message.payload.units[0].historyDelta
    ));
    assert.equal(delivered.length, 40, '合并发布不应丢失采样点');
    assert.deepEqual(delivered.at(-1), history.at(-1));
  } finally {
    client.close();
    wsServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('高频分析汇总只向网页发布最新状态', async () => {
  const httpServer = createServer();
  const wsServer = new WSServer();
  wsServer.init(httpServer);
  const port = await listen(httpServer);
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  client.on('message', (data) => messages.push(JSON.parse(data.toString())));

  try {
    await once(client, 'open');
    messages.length = 0;
    for (let index = 1; index <= 40; index += 1) {
      wsServer.broadcastFieldSummary({ sequence: index });
    }

    await new Promise((resolve) => setTimeout(resolve, 260));
    const summaries = messages.filter((message) => message.type === 'field_summary');
    assert.ok(summaries.length <= 2, `260ms 内不应发布 ${summaries.length} 个分析汇总`);
    assert.equal(summaries.at(-1)?.payload.sequence, 40);
  } finally {
    client.close();
    wsServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
