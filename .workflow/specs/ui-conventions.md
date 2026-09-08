---
title: "UI Conventions"
readMode: optional
priority: medium
category: ui
keywords:
  - ui
  - design
  - color
  - typography
  - layout
  - animation
  - component
---

# UI Conventions

- Framework: React 19 with Vite and Tailwind CSS 4.
- Entry points: `index.tsx` mounts the offline closure, field process status and test-program views.
- Components: keep device status, process state, detector results and report gates visually explicit.
- Runtime modes: distinguish offline simulation from field read-only monitoring in the UI copy and status indicators.

## Color & Theme

- Existing UI uses a dark industrial-console palette with high-contrast status colors.

## Typography

- Existing error and diagnostic surfaces use readable system/monospace fallbacks; preserve legibility for field operators.

## Layout & Spacing

- Prefer compact dashboard panels and clearly grouped process/device sections suitable for production workstations.

## Motion & Animation

- Avoid motion that obscures process state or safety status; status changes should remain observable.

## Component Patterns

- Reuse existing status-light, detector-card, process-step and report-gate patterns before adding new primitives.

## Entries
