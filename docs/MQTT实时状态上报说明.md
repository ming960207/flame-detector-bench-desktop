# MQTT 实时状态上报说明

## 1. 云端在线判定

本项目通过 MQTT 周期性上报状态包维持云端在线状态。云端应按设备状态 Topic 的最新数据时间判断在线：

- 设备持续收到状态包：在线。
- 设备 60 秒无状态包：离线。
- 离线不是设备运行状态，不应由客户端主动上报为运行或故障替代。

前端启用 MQTT 后会在状态变化时立即上报，并每 30 秒发送一次心跳状态包，保证待机状态下云端也能持续收到实时数据。

当前项目采用双通道保障：

- 前端生成完整工艺状态包后，优先提交给本地后端 `/api/mqtt/status`，由后端通过 TCP MQTT 上传云服务器。
- 如果本地后端转发接口不可用，前端再回退到浏览器 WebSocket MQTT 直连。
- 后端使用配置中的设备 `clientId`，浏览器回退连接自动追加 `_browser`，避免两个客户端因 ID 重复而被 Broker 交替踢下线。
- 后端会根据火焰探测器轮询状态独立发送 30 秒心跳，前端未打开时云端仍可获得火焰探测器在线、火警、故障状态。

## 2. Topic 规范

默认状态 Topic：

```text
dt/up/SH_F1/LINE_A1/flame_detector_bench/status
```

默认事件 Topic：

```text
dt/up/SH_F1/LINE_A1/flame_detector_bench/event
```

其中 `SH_F1`、`LINE_A1`、`flame_detector_bench` 可在系统设置的 MQTT 配置中调整。调整厂区、产线或设备编号时，状态 Topic 会同步更新。

## 3. 状态字段

状态包位于 `payload.status`，当前使用以下枚举：

| 状态 | 含义 | 触发条件 |
| --- | --- | --- |
| `RUNNING` | 运行 | 检测台流程正在执行，且未触发报警或故障 |
| `IDLE` | 待机 | 系统待机、完成或中止，且未触发报警或故障 |
| `ALARM` | 报警 | 任一火焰探测器上报 `fire=true`，或调用报警状态上报接口 |
| `FAULT` | 故障 | 任一火焰探测器上报 `fault=true`，或探测器通信连接异常 |

状态优先级为：`FAULT` 高于 `ALARM`，`ALARM` 高于 `RUNNING/IDLE`。当报警和故障同时存在时，`payload.status` 为 `FAULT`，同时 `payload.alarms` 会保留两类告警明细。

## 4. 状态包结构

示例：

```json
{
  "header": {
    "device_id": "flame_detector_bench",
    "timestamp": 1792230000000,
    "data_type": "REALTIME",
    "seq_no": "17922300000001234"
  },
  "payload": {
    "status": "RUNNING",
    "mode": "AUTO",
    "uptime": 120,
    "message": "当前工序: 工序名称",
    "metrics": {
      "process.step_index": 1,
      "process.elapsed_time": 120,
      "flame.total_count": 6,
      "flame.online_count": 6,
      "flame.fire_count": 0,
      "flame.fault_count": 0,
      "flame.connected": 1,
      "plc.connected": 1,
      "server.connected": 1
    },
    "extra_data": {
      "step_name": "工序名称",
      "flame_units": [
        {
          "index": 1,
          "address": 1,
          "online": true,
          "fire": false,
          "fault": false,
          "last_update": 1792230000000
        }
      ]
    },
    "alarms": []
  }
}
```

## 5. 事件包

报警和故障状态变化时会发布事件包：

| 事件码 | 等级 | 含义 |
| --- | --- | --- |
| `E1001` | `CRITICAL` | 探测器火警/报警触发 |
| `I1001` | `INFO` | 探测器火警/报警恢复 |
| `E2001` | `WARNING` | 探测器故障或通信故障 |
| `I2001` | `INFO` | 探测器故障恢复 |

事件用于记录突发变化；云端实时看板应以状态 Topic 的最新状态包作为当前状态来源。

## 6. 配置注意事项

- 浏览器前端连接 MQTT 时应使用 `ws://` 或 `wss://` Broker 地址。
- 当前默认云服务器地址为 `ws://115.190.63.111:8083/mqtt`。
- 后端上传云服务器时使用 TCP MQTT，当前已验证 `mqtt://115.190.63.111:1883` 可正常收发。
- 如系统设置中仍保存 `ws://115.190.63.111:8083/mqtt`，后端会自动转换为 `mqtt://115.190.63.111:1883` 进行云端上传。
- 如果云服务器启用了鉴权，需要在系统设置中填写 `username` 和 `password`。
- MQTT 发布 QoS 使用 `1`，不保留消息。
