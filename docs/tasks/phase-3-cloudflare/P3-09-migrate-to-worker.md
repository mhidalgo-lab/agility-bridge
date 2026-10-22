---
id: P3-09
title: Self-hosted to Worker migration
phase: 3
status: done
priority: low
depends_on: [P3-02]
adr: ["0006"]
lessons: [L-078]
owner: ""
---

# P3-09 — Self-hosted to Worker migration

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
Move a self-hosted deployment to Cloudflare without re-entering every token.

## Scope
- `pnpm cf:migrate --name <worker> --from <backup.db>` (`scripts/cf-migrate.ts`), from a backup made with
  `agility-bridge backup` (the source is never the live database):
  - checks the backup like `restore` does (an agility-bridge database, not from a newer release) and that the target
    Worker is deployed and booted (its D1 is migrated to the **same schema version**);
  - refuses a target with any row in users, instances, credentials, workspaces, grants, access tokens or settings
    (L-078: explicit and one-way, into an empty deployment only); audit rows already on the target (refused probes,
    L-181) stay, and the server's are added;
  - checks the **master key**: the target's key-check value for each version used by the backup's credentials must
    equal the backup's (the Worker runs with the server's key, or with a new key as current and the server's as
    `AB_MASTER_KEY_PREVIOUS`, after which the P3-08 cron re-encrypts); a mismatch is refused before anything is
    written;
  - writes one SQL file of `INSERT`s in dependency order (users, instances, credentials with their ciphertext,
    workspaces, grants, access tokens, settings, audit, and only the `crypto:*` `kv` entries; rate-limit counters,
    leases and other transient `kv` state are left out), values as SQL literals generated from typed columns, and
    applies it with `wrangler d1 execute --remote --file`;
  - compares row counts afterwards and deletes the SQL file (it holds ciphertext and token hashes).
- Sessions and OAuth devices do not exist yet; when they do (Phase 4/5), they stay out of the migration.

## Acceptance criteria
- [x] Round-trip test: a SQLite deployment with every kind of row exported and imported into local D1 equals the
      source row for row; the Worker then serves a migrated device token with the same master key.
- [x] Refusals tested before any write: a non-empty target, another schema version, a different master key.
- [x] The script's wrangler calls tested with a fake wrangler; `docs/guide/cloudflare-deploy.md` (migration section)
      lists the commands.

## Security notes
THREAT_MODEL T7, T29.

## Lessons applied
- L-078 — Migrations between deployments are explicit and one-way.

## Docs to update
- docs/guide/cloudflare-deploy.md (migration section)

## Notes
- Real run, 2026-10-22: a synthetic self-hosted deployment (sealed with staging's key, instance at an unreachable
  `agility.invalid` address) migrated into `agility-bridge-staging`. The first attempt was refused as "not empty"
  because of two audit rows from refused smoke requests (L-181); the audit log no longer counts. After the fix the
  import succeeded (counts verified) and the migrated device token listed the 13 tools on Cloudflare.

## Out of scope
- Worker → self-hosted (the reverse), merging into a non-empty deployment.
