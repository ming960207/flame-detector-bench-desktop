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

现场配置与产品型号页面需要 field 后端；在本目录可直接运行：

```powershell
npm run dev:field
```

该命令固定使用 `CLOSURE_MODE=field`，监听 `127.0.0.1:3001`。从项目根目录运行 `npm run dev:field` 则会同时启动 field 后端和前端页面。

配置模板见 `.env.example`。现场模式至少需要设置 `CLOSURE_MODE=field`、PLC 的 `PLC_MODE/PLC_IP/PLC_PORT`，以及探测器通信参数；离线模式使用默认配置即可。

服务端核心实现位于 `src/closure/`、`src/modbus/` 和 `src/plc-process-monitor.ts`；HTTP/WebSocket 入口由当前运行模式分别提供。

## 产品型号与探头映射配置

产品型号、显示名称和期望探头数量统一配置在 `server/product-profiles.json`，不在 TypeScript 中写死。当前配置默认选择 `GHT-1050-02`；部署到不同产品线时修改该文件后重新启动后端即可生效。

现场页面保存的产品配置会作为 `productDetectionConfig` 写入运行时 `system-config.json`，并覆盖同名基础配置。双波长、三波长、四波长和图探型的探头数量均由配置文件决定，后端只负责校验为 1–4 路。
