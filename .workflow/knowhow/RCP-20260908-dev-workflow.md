---
title: "火焰探测器检测台 — Dev Workflow"
type: recipe
tags: [workflow, dev-workflow, vite, electron, node, auto-generated]
created: 2026-09-08T00:00:00+08:00
source: spec-setup
---

# 火焰探测器检测台 — Dev Workflow

## Goal

在本机启动离线前端和统一后端，验证上位机界面与本地 API 的联调路径。

## Prerequisites

- Node.js 20+
- 根目录和 `server/` 依赖已安装

## Steps

1. 终端一启动后端：`npm run dev --prefix server`
2. 终端二启动前端：`npm run dev`
3. 访问 `http://127.0.0.1:3000`
4. 需要现场只读入口时使用 `npm run dev:field`，前端默认使用 `127.0.0.1:3002`。

## Expected Outcome

离线前端可在 `127.0.0.1:3000` 访问，后端默认监听 `127.0.0.1:3001`；默认模式不连接现场 PLC、探测器、MQTT 或外部报告服务。

## Common Pitfalls

- 不要把离线模式和现场模式的端口、环境变量混用。
- 桌面程序内置后端使用端口 `3003`，与开发后端端口不同。

## Related

- [[architecture-constraints]] / [[ui-conventions]]
