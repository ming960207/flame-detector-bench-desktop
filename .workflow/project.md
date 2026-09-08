# Project: 火焰探测器检测台：上位机界面原型版

## What This Is

这是一个面向生产检测现场的离线优先上位机，用于驱动和展示火焰探测器检测台的四工艺阶段检测流程、批次质量门禁、设备状态与本地审计记录。项目采用 React / TypeScript / Vite 构建前端，并通过 Electron 与 Node.js 服务支持桌面交付和现场只读监测。

## Core Value

在不依赖现场设备或外部网络的情况下，可靠地验证检测流程状态、批次放行条件和审计链，避免未满足安全或质量条件的批次被误放行。

## Requirements

### Validated

- [x] 支持离线模式下的四阶段检测流程、停止控制和完成状态流转。
- [x] 只有满足安全条件及六台探测器批次门禁的记录才能放行报告。
- [x] 通过本地追加式 JSONL 保存命令、状态快照、设备输入和检测结果。
- [x] 提供 Vite Web 开发运行方式和 Electron 单 EXE 交付方式。

### Active

- [ ] 持续验证离线检测闭环与现场只读监测入口的一致性。
- [ ] 保持 PLC / HMI / 探测器相关约束和发布门禁可追踪、可检索。
- [ ] 维护可复现的构建、测试、现场准备检查与桌面交付流程。

### Out of Scope

- 通过本项目直接写入现场 PLC 的 Q / M 区或替代硬件安全回路 — 当前项目边界是离线验证和现场只读监测。
- 将离线仿真记录作为现场合格认证的唯一证据 — 现场仍需完成受控 FAT / SAT 及硬件验证。

## Context

项目当前是已有代码库的 workflow onboarding。默认离线开发前端使用 `127.0.0.1:3000`、后端使用 `127.0.0.1:3001`；现场模式前端使用 `127.0.0.1:3002`；桌面程序内置后端使用端口 `3003`。核心入口位于 `index.tsx`，后端位于 `server/`，现场资产和发布门禁配置位于 `config/`。

## Constraints

- **Offline-first**: 默认运行不得初始化 PLC、探测器、MQTT 或外部报告连接，也不得写入现场 PLC 的 Q / DO / M 区。
- **Quality gate**: 报告放行必须基于当前批次完整的安全状态、工序状态、六台探测器结果和审计链。
- **Local runtime**: 默认服务绑定本机回环地址，现场模式保持只读设备访问边界。
- **Traceability**: PLC / HMI 静态资产、配置和发布检查结果必须可通过项目文件和脚本复核。

## Tech Stack

- **Language**: TypeScript / JavaScript
- **Framework**: React 19、Vite 6、Electron 33、Tailwind CSS 4
- **Database**: 本地 JSONL / JSON 文件；无外部数据库

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 以 brownfield 方式初始化 workflow | 代码库已存在且需要保留现有业务边界 | Accepted |
| 默认启用 research、reflection、codebase auto-sync 和 workflow 文档 Git 跟踪 | 便于后续对既有工程进行可追踪的规划与执行 | Accepted |
| 使用本地 `.workflow/` 作为项目知识、规范和状态入口 | 确保 `maestro search`、spec 和 domain 检索有稳定的项目边界 | Accepted |

## Stakeholders

- 上位机开发与维护人员
- PLC / HMI / 探测器集成与现场调试人员
- 生产检测和质量验证人员

---
*Last updated: 2026-09-08 after initialization*
