---
title: "Quality Rules"
readMode: required
priority: medium
category: review
keywords:
  - quality
  - lint
  - rule
  - enforcement
---

# Quality Rules

- Keep the default runtime offline-first and bound to loopback addresses.
- Do not add direct PLC Q / DO / M writes or external upload behavior to the offline closure path.
- Preserve request idempotency and audit-chain integrity when changing command or state handling.
- Run the relevant build and server test commands before committing behavior changes.

## Entries
