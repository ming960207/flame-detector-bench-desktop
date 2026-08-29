# 火焰探测器检测台后端

后端为当前上位机提供两种运行模式：

- `CLOSURE_MODE=offline`：本机离线四阶段闭环仿真，不连接 PLC、探测器或外部服务。
- `CLOSURE_MODE=field`：现场只读监测，读取 PLC 工序和六台火焰探测器状态，不写入 PLC `Q/M` 区。

## 开发运行

```powershell
npm install
npm run dev
```

默认监听 `127.0.0.1:3001`。生产构建和启动：

```powershell
npm run build
npm start
```

配置模板见 `.env.example`。现场模式至少需要设置 `CLOSURE_MODE=field`、PLC 的 `PLC_MODE/PLC_IP/PLC_PORT`，以及探测器通信参数；离线模式使用默认配置即可。

服务端核心实现位于 `src/closure/`、`src/modbus/` 和 `src/plc-process-monitor.ts`；HTTP/WebSocket 入口由当前运行模式分别提供。
