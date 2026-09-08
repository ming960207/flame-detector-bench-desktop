---
title: "火焰探测器检测台 — Build Workflow"
type: recipe
tags: [workflow, build-workflow, vite, typescript, electron, auto-generated]
created: 2026-09-08T00:00:00+08:00
source: spec-setup
---

# 火焰探测器检测台 — Build Workflow

## Goal

构建前端和统一后端，确认 Web / desktop 交付所需产物可以生成。

## Prerequisites

- Node.js 20+
- 根目录依赖已安装：`npm install`
- 服务端依赖已安装：`npm install --prefix server`

## Steps

1. 构建统一后端：`npm run build:server`
2. 构建桌面模式前端：`npm run build:web`
3. 如需普通 Vite 构建：`npm run build`
4. 如需生成最新单 EXE 交付包：`npm run build:single-exe`

## Expected Outcome

后端生成 `server/dist/`，前端生成 `dist/`；单 EXE 流程将产物写入 `release-latest/`。

## Common Pitfalls

- 根目录和 `server/` 是独立 package，首次运行必须分别安装依赖。
- 现场资产门禁和单 EXE 打包不等同于离线逻辑构建，交付前仍需执行对应验证脚本。

## Related

- [[architecture-constraints]] / [[quality-rules]]
