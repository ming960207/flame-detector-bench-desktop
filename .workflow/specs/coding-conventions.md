---
title: "Coding Conventions"
readMode: required
priority: high
category: coding
keywords:
  - style
  - naming
  - import
  - pattern
  - convention
  - formatting
---

# Coding Conventions

## Formatting

- Indentation: 2 spaces in JSON, TypeScript and JavaScript sources.
- Line length: not configured; preserve readable JSX and existing local style.
- Trailing commas: used in multiline TypeScript / JavaScript structures.
- Semicolons: used in TypeScript and JavaScript statements.

## Naming

- Variables/functions: camelCase.
- Classes, interfaces, types and React components: PascalCase.
- Constants: camelCase or descriptive PascalCase for exported domain values.
- Files: mixed existing convention; React components use PascalCase, utilities use kebab-case or descriptive lowercase names.

## Imports

- Style: mixed named and default imports, with named imports preferred for project modules.
- Path aliases: none detected; use relative imports.
- Order: external packages first, then project-relative imports, then styles/assets.

## Patterns

- React UI is composed from focused components under `components/` and mounted from `index.tsx`.
- Shared domain contracts are declared as TypeScript interfaces and types in `types.ts` or feature-local modules.
- Server-side behavior is organized under `server/src/` and tested with Node's built-in test runner through `tsx`.
- Runtime configuration is kept in JSON / environment files and should remain explicit at the process boundary.

## Entries
