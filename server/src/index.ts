/**
 * 火焰探测器测试台后端服务主入口
 *
 * 功能:
 * - Modbus TCP/RTU 连接PLC一体机 (DI/DO 控制)
 * - Modbus RTU/TCP 连接火焰探测器 (6台)
 * - WebSocket 实时数据推送
 * - REST API 接口
 */

import express from 'express';
import cors from 'cors';
import { createServer, request as httpRequest } from 'http';
import path from 'path';
import fs from 'fs';
import { config, PLCDeviceConfigLocal } from './config.js';
import { assertFieldRuntimeDisabled } from './field-runtime-gate.js';
import { PLCManager, FlameDetectorService } from './modbus/index.js';
import { loadPLCConfigs, savePLCConfigs, mergeWithDefaults } from './plc-config-store.js';
import { loadSystemConfig, saveSystemConfig } from './system-config-store.js';
import { WSServer } from './websocket/ws-server.js';
import { MQTTPublisher } from './mqtt-publisher.js';
import {
  IOState,
  FlameDetectorState,
  ConnectionStatus,
  SetDORequest,
  SetDOMultiRequest
} from './types.js';

// The legacy server writes physical I/O directly and must never become an alternate field path.
assertFieldRuntimeDisabled();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const server = createServer(app);
const wsServer = new WSServer();
wsServer.init(server);

console.log('========================================');
console.log('  火焰探测器测试台 - 生产环境');
console.log('  PLC数量: ' + config.plcs.length);
config.plcs.forEach((p, i) => {
  const addr = p.mode === 'RTU' ? (p.serialPath || 'COM?') : `${p.ip}:${p.port}`;
  console.log(`  PLC${i + 1}: ${p.name} (${addr}) ${p.enabled ? '启用' : '禁用'}`);
});
console.log('  火焰探测器: ' + config.flame.units.length + '台');
console.log('========================================');

const plcManager = new PLCManager();
const flameService = new FlameDetectorService(config.flame);
const mqttPublisher = new MQTTPublisher(config.mqttConfig);

let connectionStatus: ConnectionStatus = {
  relay: {
    connected: false,
    ip: config.plc.ip,
    port: config.plc.port,
  },
  relays: [],
  flame: { connected: false, mode: config.flame.mode },
};

function updateConnectionStatus(): void {
  const statuses = plcManager.getAllStatus();
  connectionStatus.relays = statuses;
  if (statuses.length > 0) {
    const first = statuses[0];
    connectionStatus.relay = {
      connected: first.connected,
      mode: first.mode,
      ip: first.ip,
      port: first.port,
      serialPath: first.serialPath,
      lastError: first.lastError,
    };
  }
  connectionStatus.flame = flameService.getStatus();
}

// ==================== PLC Manager 事件 ====================

plcManager.on('relay:connected', () => {
  updateConnectionStatus();
  wsServer.broadcastConnectionStatus(connectionStatus);
});

plcManager.on('relay:disconnected', () => {
  updateConnectionStatus();
  wsServer.broadcastConnectionStatus(connectionStatus);
});

plcManager.on('relay:error', () => {
  updateConnectionStatus();
  wsServer.broadcastConnectionStatus(connectionStatus);
});

plcManager.on('relay:data', (state: IOState) => {
  wsServer.broadcastIOState(state);
});

plcManager.on('status:changed', () => {
  updateConnectionStatus();
});

// ==================== 火焰探测器事件 ====================

flameService.on('connected', () => {
  updateConnectionStatus();
  wsServer.broadcastConnectionStatus(connectionStatus);
});

flameService.on('error', () => {
  updateConnectionStatus();
  wsServer.broadcastConnectionStatus(connectionStatus);
});

flameService.on('flame_state', (state: FlameDetectorState) => {
  wsServer.broadcastFlameState(state);
  mqttPublisher.handleFlameState(state, connectionStatus);
});

// ==================== WebSocket 消息处理 ====================

interface SetDORequestExt extends SetDORequest { relayId?: string; }
interface SetDOMultiRequestExt extends SetDOMultiRequest { relayId?: string; }

wsServer.on('set_do', async (req: SetDORequestExt) => {
  try {
    const relayId = req.relayId || config.plcs[0]?.id;
    if (!relayId) throw new Error('没有可用的PLC设备');
    await plcManager.writeDO(relayId, req.channel, req.value);
  } catch (error) {
    wsServer.broadcastError(`设置 DO${req.channel} 失败: ${error instanceof Error ? error.message : error}`);
  }
});

wsServer.on('set_do_multi', async (req: SetDOMultiRequestExt) => {
  try {
    const relayId = req.relayId || config.plcs[0]?.id;
    if (!relayId) throw new Error('没有可用的PLC设备');
    await plcManager.writeDOMulti(relayId, req.channels);
  } catch (error) {
    wsServer.broadcastError(`批量设置 DO 失败: ${error instanceof Error ? error.message : error}`);
  }
});

wsServer.on('set_all_do', async (payload: { values: boolean[]; relayId?: string }) => {
  try {
    const relayId = payload.relayId || config.plcs[0]?.id;
    if (!relayId) throw new Error('没有可用的PLC设备');
    await plcManager.writeAllDO(relayId, payload.values);
  } catch (error) {
    wsServer.broadcastError(`设置所有 DO 失败: ${error instanceof Error ? error.message : error}`);
  }
});

wsServer.on('set_only_one_do', async (payload: { channel: number; relayId?: string }) => {
  try {
    const relayId = payload.relayId || config.plcs[0]?.id;
    if (!relayId) throw new Error('没有可用的PLC设备');
    await plcManager.setOnlyOneDO(relayId, payload.channel);
  } catch (error) {
    wsServer.broadcastError(`设置单通道 DO${payload.channel} 失败: ${error instanceof Error ? error.message : error}`);
  }
});

wsServer.on('disconnect_all_do', async (payload?: { relayId?: string }) => {
  try {
    const relayId = payload?.relayId || config.plcs[0]?.id;
    if (!relayId) throw new Error('没有可用的PLC设备');
    await plcManager.disconnectAllDO(relayId);
  } catch (error) {
    wsServer.broadcastError(`断开所有 DO 失败: ${error instanceof Error ? error.message : error}`);
  }
});

wsServer.on('client_connected', (client) => {
  updateConnectionStatus();
  wsServer.broadcastConnectionStatus(connectionStatus);
  const allStates = plcManager.getAllCurrentStates();
  allStates.forEach(state => wsServer.broadcastIOState(state));
  wsServer.sendFlameState(client, flameService.getCurrentState());
});

// ==================== REST API ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), plc: connectionStatus.relay, flame: connectionStatus.flame });
});

app.get('/api/status', (req, res) => {
  res.json({ connection: connectionStatus, wsClients: wsServer.getClientCount(), mqtt: { connected: mqttPublisher.isConnected() } });
});

app.get('/api/io', (req, res) => {
  const states = plcManager.getAllCurrentStates();
  res.json(states.length > 0 ? states[0] : { relayId: '', di: [], do: [], timestamp: Date.now() });
});

app.get('/api/io/all', (req, res) => {
  res.json(plcManager.getAllCurrentStates());
});

app.get('/api/relays/:relayId/io', (req, res) => {
  const ctrl = plcManager.getController(req.params.relayId);
  if (!ctrl) return res.status(404).json({ error: `PLC ${req.params.relayId} 不存在` });
  res.json({ ...ctrl.getCurrentState(), relayId: req.params.relayId });
});

app.post('/api/do/:channel', async (req, res) => {
  try {
    const channel = parseInt(req.params.channel, 10);
    const { value, relayId } = req.body;
    const targetId = relayId || config.plcs[0]?.id;
    if (!targetId) return res.status(400).json({ error: '没有可用的PLC设备' });
    await plcManager.writeDO(targetId, channel, value);
    res.json({ success: true, relayId: targetId, channel, value });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/do', async (req, res) => {
  try {
    const { values, relayId } = req.body;
    const targetId = relayId || config.plcs[0]?.id;
    if (!targetId) return res.status(400).json({ error: '没有可用的PLC设备' });
    await plcManager.writeAllDO(targetId, values);
    res.json({ success: true, relayId: targetId, values });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/do/only/:channel', async (req, res) => {
  try {
    const channel = parseInt(req.params.channel, 10);
    const { relayId } = req.body;
    const targetId = relayId || config.plcs[0]?.id;
    if (!targetId) return res.status(400).json({ error: '没有可用的PLC设备' });
    await plcManager.setOnlyOneDO(targetId, channel);
    res.json({ success: true, relayId: targetId, channel });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/do/disconnect-all', async (req, res) => {
  try {
    const { relayId } = req.body;
    const targetId = relayId || config.plcs[0]?.id;
    if (!targetId) return res.status(400).json({ error: '没有可用的PLC设备' });
    await plcManager.disconnectAllDO(targetId);
    res.json({ success: true, relayId: targetId });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ==================== PLC管理 API ====================

app.get('/api/relays', (req, res) => {
  res.json({ statuses: plcManager.getAllStatus() });
});

app.post('/api/relays', async (req, res) => {
  try {
    const { id, name, mode, ip, port, slaveId, serialPath, baudRate, enabled, diCount, doCount } = req.body;
    if (!id || !name) return res.status(400).json({ error: '缺少必要参数: id, name' });
    const normalizedMode: PLCDeviceConfigLocal['mode'] = mode === 'TCP' || mode === 'RTU' || mode === 'S7' ? mode : 'S7';
    const newCfg: PLCDeviceConfigLocal = {
      id, name,
      mode: normalizedMode,
      ip: ip || '192.168.2.1',
      port: port || (normalizedMode === 'S7' ? 102 : 502),
      slaveId: slaveId || 1,
      serialPath, baudRate,
      enabled: enabled !== false,
      diCount: diCount || 18,
      doCount: doCount || 12,
    };
    const connected = await plcManager.addPLC(newCfg);
    config.plcs.push(newCfg);
    await savePLCConfigs(config.plcs);
    updateConnectionStatus();
    wsServer.broadcastConnectionStatus(connectionStatus);
    res.json({ success: true, config: newCfg, connected });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/relays/:relayId', async (req, res) => {
  try {
    const { relayId } = req.params;
    const ctrl = plcManager.getController(relayId);
    if (!ctrl) return res.status(404).json({ error: `PLC ${relayId} 不存在` });
    const existing = ctrl.getConfig();
    const updated: PLCDeviceConfigLocal = { ...existing, ...req.body, id: relayId };
    await plcManager.addPLC(updated);
    const idx = config.plcs.findIndex(p => p.id === relayId);
    if (idx >= 0) config.plcs[idx] = updated;
    await savePLCConfigs(config.plcs);
    updateConnectionStatus();
    wsServer.broadcastConnectionStatus(connectionStatus);
    res.json({ success: true, config: updated });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/relays/:relayId', async (req, res) => {
  try {
    const { relayId } = req.params;
    await plcManager.removePLC(relayId);
    const idx = config.plcs.findIndex(p => p.id === relayId);
    if (idx >= 0) config.plcs.splice(idx, 1);
    await savePLCConfigs(config.plcs);
    updateConnectionStatus();
    wsServer.broadcastConnectionStatus(connectionStatus);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/relays/:relayId/do/:channel', async (req, res) => {
  try {
    const { relayId } = req.params;
    const channel = parseInt(req.params.channel, 10);
    const { value } = req.body;
    await plcManager.writeDO(relayId, channel, value);
    res.json({ success: true, relayId, channel, value });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ==================== 火焰探测器 API ====================

app.get('/api/flame/devices', (req, res) => {
  res.json(flameService.getCurrentState());
});

app.get('/api/flame/status', (req, res) => {
  res.json(flameService.getStatus());
});

app.put('/api/flame/config', async (req, res) => {
  try {
    const newFlameConfig = req.body;
    flameService.updateConfig({ ...config.flame, ...newFlameConfig });
    await flameService.disconnect();
    await flameService.connect();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ==================== 配置 API ====================

app.get('/api/config', (req, res) => {
  res.json({
    plc: config.plc,
    plcs: config.plcs,
    flame: config.flame,
    pollIntervalDI: config.pollIntervalDI,
  });
});

app.get('/api/system-config', async (req, res) => {
  try {
    const store = await loadSystemConfig();
    res.json({ success: true, config: store });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/system-config', async (req, res) => {
  try {
    const { steps, modbusConfig, plcConfig, flameConfig, wateringConfig, doRelations, mqttConfig } = req.body;
    if (!Array.isArray(steps)) return res.status(400).json({ error: 'steps 必须是数组' });
    const store = { steps, modbusConfig, plcConfig, flameConfig, wateringConfig, doRelations, mqttConfig, lastUpdated: Date.now() };
    await saveSystemConfig(store);
    
    // 实时同步配置到运行内存中
    if (doRelations) {
      config.doRelations = doRelations;
    }
    if (mqttConfig) {
      config.mqttConfig = mqttConfig;
      mqttPublisher.updateConfig(mqttConfig);
    }
    
    res.json({ success: true, lastUpdated: store.lastUpdated });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/mqtt/status', async (req, res) => {
  try {
    const { topic, payload } = req.body || {};
    if (!topic || !payload) return res.status(400).json({ error: '缺少 topic 或 payload' });
    const success = await mqttPublisher.publish(topic, payload);
    res.status(success ? 200 : 503).json({ success, connected: mqttPublisher.isConnected() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ==================== 代理上传报告 ====================

app.post('/api/external/upload/report', (req, res) => {
  const options = {
    hostname: '115.190.63.111',
    port: 80,
    path: '/api/external/upload/report',
    method: 'POST',
    headers: { ...req.headers, host: '115.190.63.111' }
  };
  const proxyReq = httpRequest(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: `Proxy Error: ${e.message}` });
  });
  req.pipe(proxyReq);
});

// ==================== 启动服务 ====================

async function start(): Promise<void> {
  console.log('\n正在启动服务...\n');

  console.log('[启动] 加载PLC配置...');
  const savedConfigs = await loadPLCConfigs();
  const plcConfigsToUse = mergeWithDefaults(savedConfigs.length > 0 ? savedConfigs : config.plcs);
  config.plcs = plcConfigsToUse;
  if (savedConfigs.length === 0) await savePLCConfigs(config.plcs);

  console.log('[启动] 初始化PLC模块...');
  await plcManager.initializeAll(config.plcs);

  console.log('[启动] 加载系统组态配置...');
  const sysConfig = await loadSystemConfig();
  if (sysConfig?.doRelations) {
    config.doRelations = sysConfig.doRelations as any;
    console.log('[启动] 加载了上位机DO关联配置');
  }
  if (sysConfig?.mqttConfig) {
    config.mqttConfig = sysConfig.mqttConfig;
    mqttPublisher.updateConfig(sysConfig.mqttConfig as any);
    console.log('[启动] 加载了上位机MQTT配置');
  }
  mqttPublisher.connect();

  console.log('[启动] 连接火焰探测器...');
  await flameService.connect();

  updateConnectionStatus();

  server.listen(config.serverPort, () => {
    console.log('\n========================================');
    console.log(`  火焰探测器测试台服务已启动!`);
    console.log(`  HTTP: http://localhost:${config.serverPort}`);
    console.log(`  WebSocket: ws://localhost:${config.serverPort}`);
    console.log(`  PLC数量: ${plcManager.getAllStatus().length}`);
    console.log('========================================\n');
  });
}

async function shutdown(): Promise<void> {
  console.log('\n正在关闭服务...');
  await plcManager.disconnectAll();
  await flameService.disconnect();
  mqttPublisher.disconnect();
  wsServer.close();
  server.close();
  console.log('服务已关闭');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
