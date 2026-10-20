---
id: P0-01
title: Bootstrap the monorepo
phase: 0
status: review
priority: high
depends_on: [P0-14]
adr: ["0004", "0003"]
lessons: [L-102, L-132, L-006]
owner: "Matias Hidalgo"
---

# P0-01 — Bootstrap the monorepo

## Goal
A reproducible pnpm/TypeScript monorepo with the package boundaries of ARCHITECTURE §2, so later tasks add code, not structure.

## Decisions
- D-02 (2026-10-19): unscoped npm package `agility-bridge` (a `0.0.0` placeholder reserves the name),
  `ghcr.io/mhidalgo-lab/agility-bridge`, MCP Registry `io.github.mhidalgo-lab/agility-bridge`, docs on GitHub Pages.
- D-15 (2026-10-19): Node 24 LTS and later (`engines: ">=24"`); CI covers 24 and the current LTS.

## Scope
- pnpm workspace; Node 24 LTS pinned (`.nvmrc`, `engines: ">=24"`); pnpm pinned through `packageManager` and corepack.
- Packages `core`, `storage`, `storage-sqlite`, `auth`, `http-app`, `admin-ui`; apps `cli`, `worker`.
- `tsconfig.base.json` with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedDeclarations`.
- Biome (lint + format), Vitest workspace configuration, tsdown builds, Changesets, Lefthook (format, lint, DCO sign-off on commit-msg).
- Scripts: runtime-import check (no `node:*`, `process` or `Buffer` in web-standard packages) and SPDX header check.
- `pnpm-workspace.yaml` supply-chain settings: minimum release age, trust policy without downgrades, blocked exotic sub-dependencies, explicit build-script approvals.
- A placeholder `agility-bridge` CLI that prints its version to stderr.

## Acceptance criteria
- [x] `corepack enable && pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes from a fresh clone on Linux, macOS and Windows. *(Verified on Linux, 2026-10-20; macOS and Windows are verified by the P0-03 OS matrix.)*
- [x] The runtime-import check fails on a `node:` import in `packages/core` (test).
- [x] The SPDX check fails on a file without the header (test).
- [x] Only `apps/cli` (`agility-bridge`) is publishable; every other package is private.
- [x] Exact versions pinned for TypeScript, Biome, Vitest, tsdown, Hono, the MCP SDK v2, zod 4, Drizzle 0.x and Wrangler; lockfile committed.

## Security notes
Supply chain from the first commit (THREAT_MODEL T18): minimum release age, no exotic sub-dependencies, explicit approval for dependency build scripts.

## Lessons applied
- L-102 — Keep the Node footprint portable.
- L-132 — Harden dependency intake.
- L-006 — One task per branch and PR; extra work becomes a new task.

## Docs to update
- README.md (development section)
- docs/ARCHITECTURE.md §9 if the layout changes

## Out of scope
- CI workflows (P0-03)
- Feature code
