---
title: "Architecture Constraints"
readMode: required
priority: high
category: arch
keywords:
  - architecture
  - module
  - layer
  - boundary
  - dependency
  - structure
---

# Architecture Constraints

## Module Structure

- Type: single-package desktop/web application with a separately built Node.js server package.
- Key modules: `components/` (React UI), `server/` (runtime and tests), `desktop/` (Electron main/preload), `utils/` (shared frontend utilities), `config/` (field and release contracts), `scripts/` (build and verification workflows).

## Layer Boundaries

- Browser UI owns presentation and user interaction.
- Frontend clients and utilities own request/transport shaping, not device-side writes.
- `server/src/` owns process orchestration, local persistence, device adapters and API behavior.
- `desktop/` owns Electron lifecycle and process packaging; it must not duplicate server domain rules.
- `config/` and `scripts/` define release/field gates and should be treated as operational contracts.

## Dependency Rules

- Frontend imports React, UI libraries and local utilities; it does not directly access PLC or device transports.
- Server tests exercise server modules through the package test scripts; keep hardware-facing behavior behind adapters/configuration.
- Default offline behavior must not initialize PLC, detector, MQTT or external report connections.

## Technology Constraints

- Runtime: Node.js 20+ for the documented development workflow.
- Module system: ESM for the Vite and server packages; Electron main/preload files use CommonJS where required by the existing entry points.
- Strict mode: TypeScript compiler configuration is the source of truth; preserve existing strictness and generated boundaries.

## Entries
