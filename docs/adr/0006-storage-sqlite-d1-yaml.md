# ADR-0006 — Storage: one SQLite schema for Node and D1, YAML for stdio

- **Status:** proposed
- **Date:** 2026-10-16
- **Related:** P2-01, P2-02, P3-02, L-071, L-072, L-073, L-076, L-102

## Context

Remote modes need durable state: instances, credentials, workspaces, grants, device tokens, OAuth state, sessions, audit
rows, settings. Self-hosted Node and Cloudflare Workers must share one data model. The local stdio mode should need no
database at all.

## Decision

- **One relational schema** in the SQLite dialect (Drizzle, pinned 0.x), shared by Node (`node:sqlite`, built into
  Node 24) and Cloudflare D1.
- **One migration history**: forward-only, checksummed SQL migrations embedded in the build and applied by the same
  runner on both runtimes (on Workers at first request, single-flight). No Wrangler migration history. A database newer
  than the binary is refused. One database fixture per released minor is kept and upgrade-tested.
- A runtime-neutral `Storage` interface with adapters: `memory` (tests), `yaml` (read-only, stdio), `sqlite` (Node),
  `d1` (Workers). Every adapter passes the same contract suite.
- A generic `kv` table (key, value, expires_at) holds short-lived state on every runtime: OAuth provider records,
  single-use markers (taken atomically), sign-in transactions, setup links, approval records, cached client metadata.
- Conditional writes are single statements (`ON CONFLICT`, `WHERE`, `RETURNING`, affected-row counts) or one D1
  `batch()`; never read-decide-write in application code.
- SQLite files are created `0600` with WAL, `busy_timeout` and foreign keys on; backups are consistent and `0600`.
- **stdio mode** reads configuration from environment variables or a YAML file (secrets only as `${ENV}` or keychain
  references) and keeps no database.

## Consequences

- Node and Workers behave the same; migrations are tested once.
- D1 limits (statement size, bound parameters, no interactive transactions) constrain query design for everyone.
- Audit and OAuth state are unavailable in stdio mode by design (write outcomes are logged to stderr there).

## Alternatives considered

- **PostgreSQL for self-hosting:** rejected for 1.0; a second dialect doubles migrations and tests.
- **Workers KV for OAuth state:** rejected; not transactional, and Node would need a different store.
- **Drizzle 1.0 release candidates:** deferred until stable (migration layout changes).
