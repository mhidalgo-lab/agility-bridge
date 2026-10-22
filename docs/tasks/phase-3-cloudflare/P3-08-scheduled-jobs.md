---
id: P3-08
title: "Scheduled jobs: audit purge and key rotation on D1"
phase: 3
status: review
priority: medium
depends_on: [P3-02]
adr: ["0007"]
lessons: [L-075, L-097]
owner: ""
---

# P3-08 — Scheduled jobs: audit purge and key rotation on D1

> Refined 2026-10-22 (tasks/README rule 7).

## Goal
Housekeeping works on Workers without a long-running process.

## Scope
- A `scheduled` handler on the Worker with one cron trigger (every 15 minutes, `wrangler.jsonc`), running in bounded
  slices that fit the Free plan (50 D1 queries and 50 subrequests per invocation, L-097):
  - **audit retention**: rows older than `AB_AUDIT_RETENTION_DAYS` deleted, at most a few batches per run;
  - **expired `kv` entries** purged (rate-limit and one-time state);
  - **master-key rotation**: when `AB_MASTER_KEY_PREVIOUS` is set and credentials are still on an older version, a
    batch of them is re-encrypted per run (compare-and-swap per row, so interrupted and concurrent runs are safe);
    a `kv` lease keeps two runs (or a run and `keys rotate`) from working the same batch;
  - **credential revalidation** (`AB_CREDENTIAL_REVALIDATION_HOURS`): at most one credential per run, oldest first.
- `revalidate()` takes a limit (oldest first); `purgeAudit()` takes a batch bound; the Node scheduler keeps its
  behaviour.
- The jobs share the boot of the `fetch` path (settings, keyring, storage); a failing job is logged and does not stop
  the others.

## Acceptance criteria
- [x] workerd tests (Miniflare `scheduled`): retention purges only old rows; expired `kv` entries go; an interrupted
      rotation (one batch per run) finishes over several runs and never double-rotates; a held lease skips the run;
      revalidation touches at most one credential per run.
- [x] Unit tests for the new limits; the Node behaviour unchanged.
- [x] `docs/guide/cloudflare-deploy.md` (housekeeping and key rotation on Workers).

## Security notes
THREAT_MODEL T7.

## Lessons applied
- L-075 — Envelope encryption done properly (resumable compare-and-swap rotation).
- L-097 — Design for the Free plan's limits, not its tolerance.

## Docs to update
- docs/guide/cloudflare-deploy.md

## Out of scope
- Retiring a key version from the Worker (an operator action through the admin API or CLI).
