# ADR-0004 — TypeScript monorepo, runtime-agnostic core, Hono

- **Status:** accepted (owner, 2026-10-16)
- **Date:** 2026-10-16
- **Related:** [ARCHITECTURE.md](../ARCHITECTURE.md) §2, P0-01, L-095, L-102

## Context

The same server must run as a local stdio process started by an MCP client, as a self-hosted Node/Docker HTTP server,
and as a Cloudflare Worker. Duplicating the logic per runtime would multiply bugs and security review effort.

## Decision

- A **pnpm monorepo in TypeScript** (strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
- Packages `core`, `auth`, `http-app`, `admin-ui` (and `storage` interfaces) use **web-standard APIs only**: `fetch`,
  WebCrypto, `URL`, streams, `TextEncoder`. A lint rule and a CI script refuse `node:*` imports, `process` and `Buffer`
  there. Clock, randomness, storage and outbound `fetch` are injected.
- Runtime-specific code lives only in adapters and apps: `storage-sqlite` (Node), the D1 adapter, `apps/cli` (Node:
  stdio, `serve`, management commands) and `apps/worker` (Cloudflare).
- **Hono** is the HTTP layer (runs on Workers and on Node through `@hono/node-server`).
- The admin panel is **server-rendered Hono JSX** with auto-escaping only and minimal static JavaScript (no inline
  scripts or styles, strict CSP).
- Tooling: Biome (lint/format), Vitest, tsdown (bundling), Changesets, Lefthook. Exact versions are pinned in P0-01.

## Consequences

- One implementation of tools, access control, output shaping and audit for every deployment mode.
- Some Node conveniences (e.g. custom TLS agents) must be injected from the Node app into the core through interfaces
  (see [ADR-0014](0014-supported-agility-installations.md) for custom CA bundles).
- Only one package (`agility-bridge`, the CLI) is published to npm at first; internal packages stay private until their
  contracts are stable.

## Alternatives considered

- **Node-only core with a separate Worker port:** rejected; two implementations drift.
- **Another language (Java, Go, Python):** rejected for this project; the MCP TypeScript SDK v2 and Workers support
  are the reference implementations for the transports we need.
