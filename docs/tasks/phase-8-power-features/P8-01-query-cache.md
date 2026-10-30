---
id: P8-01
title: Query cache
phase: 8
status: in-progress
priority: medium
depends_on: [P6-13]
adr: ["0010"]
lessons: [L-098, L-113, L-116]
owner: "agent (lane A)"
---

# P8-01 — Query cache

## Goal
Fewer Agility requests for repeated reads, without ever mixing scopes.

## Scope
- **Where it hooks in:** `AgilityClient.query` (`query.v1` and `query.legacy.v1` reads) only. `meta.v1`, `rest-1.v1` reads, attachment content and every write stay uncached (metadata has its own store, P6-39). A hit spends nothing from the call budget and is not a request (L-116).
- **Tiers:** a bounded in-memory LRU in every host (stdio, Node `serve`, Worker isolate): 200 entries, 8 MiB of text, no entry above 256 KiB, entries re-parsed on every hit so no caller shares a mutable object. Optional second tier on Workers: the Cache API, **sealed** with a keyring purpose key (`cache-body`, AES-GCM, the entry id bound as additional data), switched on separately (`AB_QUERY_CACHE_EDGE=on`).
- **Keys:** a keyed hash (HMAC-SHA-256, keyring purpose `cache-id`; a random per-process key on stdio) over the canonical JSON of: endpoint, instance id and URL, workspace id, grant id, credential id (or, for a pass-through caller, the fingerprint of the caller's own Agility token), credential kind, allowed projects and `includeChildren`, asset-type allow/deny lists, the whole limits object, and the normalised compiled query (object keys sorted). The lookup happens inside the tool call, after authentication and the access decision, so a denied request never reaches the cache.
- **Freshness:** TTL 0-60 s (`AB_QUERY_CACHE_TTL`, default 0 = off, D-242), the same for every entry; a caller that has write tools never reads or fills the cache (read-your-writes), and the write layer's own reads pass `fresh`. Local admin changes clear the in-memory cache with the access cache.
- **Honest status:** `whoami` reports `queryCache: { mode, ttlSeconds, shared }` where `shared` is `off`, `unverified`, `verified` (the first write was read back intact) or `unavailable` (the Cache API stored nothing or threw: `workers.dev`, some access products; rechecked after 10 minutes). No hit counters in `whoami` (they would show other callers' activity).
- **Measured:** `pnpm bench:worker` gets three paths (cache off, memory hit, shared-tier hit) with the Agility requests per call.

## Acceptance criteria
- [x] Isolation tests: every scope dimension (instance, workspace, grant, credential, pass-through token, projects, asset types, limits, query, endpoint) changes the entry id; two scopes of one cache never see each other's entries; two pass-through callers never share an entry; a denied or revoked request makes no upstream call and returns no data.
- [x] Cached bodies in the shared tier are sealed and bound to their entry id; tampering, replay under another id and another master key are misses.
- [x] Cache status reported truthfully: `verified` only after a read-back, `unavailable` when the cache stores nothing or throws, and not used while unavailable.
- [x] Writers never use the cache; `fresh` skips it; a failing cache never fails a read; errors are never cached.
- [x] Bench paths and baseline for off, memory hit and shared-tier hit; guide `docs/guide/query-cache.md`; settings in the configuration reference; THREAT_MODEL T16 updated.
- [ ] A run on a deployed Worker (workers.dev and a custom domain) to confirm the Cache API behaviour and its subrequest accounting on the Free plan: *unverified*, left for the Phase 8 review's live pass (needs the owner's Cloudflare account beyond the staging Worker; see P8-13).

## Security notes
THREAT_MODEL T16 (cross-workspace cache mixing), T21 (no request data in module state: the cache holds only keyed, scope-bound entries), T3 (projects are part of the key and of the query).

## Lessons applied
- L-098 — The Cache API is local and sometimes a no-op.
- L-113 — Cache keys carry every scope dimension.
- L-116 — Quotas count logical upstream calls.

## Docs to update
- docs/guide/query-cache.md (new)
- docs/guide/configuration.md
- docs/THREAT_MODEL.md

## Out of scope
- Caching writes, metadata or non-query reads.
- Invalidation across isolates (the TTL bounds staleness; callers with write tools do not cache).
- A cache for the admin panel.
