---
title: "火焰探测器检测台 — Test Workflow"
type: recipe
tags: [workflow, test-workflow, node-test, tsx, auto-generated]
created: 2026-09-08T00:00:00+08:00
source: spec-setup
---

# 火焰探测器检测台 — Test Workflow

## Goal

运行统一后端的领域和运行时测试，覆盖产品、继电器、探测器、配置、审计与现场波形分析行为。

## Prerequisites

- Node.js 20+
- 服务端依赖已安装：`npm install --prefix server`

## Steps

1. 运行完整服务端测试：`npm test --prefix server`
2. 运行产品相关子集：`npm run test:product --prefix server`
3. 修改后端逻辑时先运行相关测试，再执行 `npm run build:server`

## Expected Outcome

Node.js `node:test` 测试全部通过，且服务端 TypeScript 构建成功。

## Common Pitfalls

- 测试命令属于 `server/` package，不能用根目录的 `npm test` 替代。
- 与设备无关的离线和持久化测试应保持可在无现场硬件环境中运行。

## Related

- [[test-conventions]] / [[quality-rules]]
