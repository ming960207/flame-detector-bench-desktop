---
title: "Test Conventions"
readMode: required
priority: high
category: test
keywords:
  - test
  - coverage
  - mock
  - fixture
  - assertion
  - framework
---

# Test Conventions

## Framework

- Framework: Node.js built-in `node:test` executed through `tsx`.
- Run command: `npm test --prefix server`.

## Directory Structure

- Pattern: server tests are co-located under `server/test/` and target modules in `server/src/`.

## Naming Conventions

- Test files: descriptive kebab-case names ending in `.test.ts`.

## Patterns

- Tests use explicit fixtures and temporary/local stores for audit and runtime behavior.
- Product, relay, detector, configuration and persistence behavior is covered by focused test files.
- Prefer testing safety gates, idempotency, failure rollback and field/offline boundaries.

## Entries
