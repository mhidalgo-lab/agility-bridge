---
id: P6-39
title: Keep instance metadata across isolates and measure Phase 6 tools on the Worker bench
phase: 6
status: done
priority: medium
depends_on: [P6-13]
adr: []
lessons: [L-113, L-327]
owner: ""
---

# P6-39 — Keep instance metadata across isolates and measure Phase 6 tools on the Worker bench

## Goal
A cold call on a new isolate pays one metadata request per asset type (9 to 17 per Phase 6 tool, 1.9 MB parsed for the type list), which is at or over the 10 ms Workers Free CPU limit; `bench:worker` measures only warm paths and no Phase 6 tool. (Found by the Phase 6 review, [P6-13](P6-13-phase-6-review.md).)

## Scope
- A per-instance metadata cache that outlives the isolate (Cache API, KV or D1; built on D1's `kv` table, D-135), keyed by instance and the metadata fingerprint the service already tracks, with the existing 1 h TTL and ETag invalidation; never shared across instances (L-096).
- `worker-bench` gains a cold-metadata path and one path each for `get_sprint`, `get_asset_history`, `get_portfolio_tree` and one report.
- Prompt argument schemas are converted at module load with the tool schemas (first `prompts/list` costs 75 ms cold).

## Acceptance criteria
- [x] A second request on a fresh isolate reads metadata from the shared cache: fewer upstream requests (test with two service instances over one store).
- [x] No metadata crosses instances; a changed fingerprint drops the entry.
- [x] The bench lists the new paths and the CPU budget is recorded (docs/guide/cloudflare-limits.md, Measured cost; there is no docs/dev/performance.md).

## Security notes
None beyond the shared rules in AGENTS.md; a change to what is read or logged updates THREAT_MODEL in the same PR.

## Lessons applied
- L-113
- L-327

## Docs to update
- The pages of the tools and files touched; docs/reference generated pages.

## Out of scope
- Anything not listed under Scope.
