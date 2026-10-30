# Query cache

> Repeated reads answered without asking Agility again (P8-01). **Off by default.** Design: [ADR-0010](../adr/0010-platform-limits-strategy.md),
> threat: [THREAT_MODEL](../THREAT_MODEL.md) T16, decisions D-242 to D-246 in [pending decisions](../pending-decisions/phase-8.md).

## What it does

Reads that go to Agility's `query.v1` (work items, sprints, searches, `whoami`'s member lookup, ...) are remembered for a
few seconds. The same read by the same person in the same workspace within that time is answered from memory: no
Agility request, no budget unit, and it does not count against a quota (L-116). Nothing else is cached: not metadata
(it has its own store), not single-asset reads, not attachments, and never a write.

## Turning it on

| Setting | Default | Meaning |
|---|---|---|
| `AB_QUERY_CACHE_TTL` | `0` (off) | Seconds (0 to 60) an answer is reused. Works on stdio, `serve` and the Worker |
| `AB_QUERY_CACHE_EDGE` | `off` | Workers only: also keep sealed answers in the Cache API so other isolates of the same data centre can reuse them |

Pick a TTL by how fresh an answer must be: 10 to 30 seconds takes the repeats out of a burst of related questions
(an agent asking for the same sprint three times) without ever showing something older than half a minute.

## What is never shared

Every entry is named by a keyed hash (HMAC-SHA-256) over **everything that decides what a caller may see**: the
endpoint, the Agility instance, the workspace, the grant, the credential (for a pass-through caller, a fingerprint of the
caller's own Agility token, never the token), the allowed projects, the asset-type allow and deny lists, every limit,
and the compiled query with its keys sorted. Change any of them and the entry is a different one. The lookup happens
inside the tool call, after authentication and the access decision: a request that is denied, or whose token was
revoked, never reaches the cache and never asks Agility. The hash key is per process on stdio and `serve`, and a master-key
purpose key on the Worker; ids are never shown to anyone.

Answers from Agility stay **untrusted data**: a hit is parsed again and goes through the same output shaper and
untrusted-data envelope as a live answer, so a cached title is as fenced as a fresh one.

## When it is skipped

- A caller who has **write tools** never reads or fills the cache, so a read after a write shows the write. The write
  layer's own reads pass `fresh` as well.
- Errors are not cached. A cache failure (a broken shared tier) is a miss, never an error.
- Answers above 256 KiB are not cached.
- Local admin changes (instances, credentials, workspaces, grants, tokens) clear the in-memory cache together with the
  access cache. Other processes keep their entries until the TTL ends: a changed project scope changes the key, a
  revoked grant is refused before the lookup, a replaced Agility token under the same credential id can show up to one
  TTL of the previous member's answers to the same grant, so keep the TTL short where that matters.

## The shared tier on Workers (optional)

The Workers Cache API is local to one data centre, can be a silent no-op (some `workers.dev` setups and access products),
and its limits on the Free plan are not fully documented, so it is a second switch. With `AB_QUERY_CACHE_EDGE=on`:

- bodies are **sealed** (AES-256-GCM, a key derived from the master key for this purpose, the entry id bound as
  additional data) before they leave the isolate, so what the cache holds is useless without the master key, and a body
  copied to another entry, edited, or read under another master key is a miss;
- the tier reports **`verified`** only after reading its first write back intact, and **`unavailable`** when the cache
  stored nothing or threw; an unavailable tier is not used and is tried again after 10 minutes;
- `whoami` shows the truth: `queryCache: { mode: "memory+shared", ttlSeconds, shared: "off" | "unverified" | "verified" | "unavailable" }`.
  No hit counters are shown (they would reveal other callers' activity).

*Unverified:* behaviour on a deployed Worker (which hostnames work, whether `put` and `match` count toward the Free
plan's 50 subrequests, a hit from a second data centre) has only been run against a fake Cache API; see
[P8-13](../tasks/phase-8-power-features/P8-13-query-cache-live-check.md). Until then treat the shared tier as an
experiment and read `whoami`.

## What it costs

Measured with `pnpm bench:worker` (Node, the V8 of workerd; fakes for Agility), one `search_work_items` call:

| Path | Agility requests | CPU (relative to the bench calibration) |
|---|---|---|
| cache off | 1 | 0.63 |
| memory hit | 0 | 0.67 |
| shared-tier hit (decrypt and parse) | 0 | 0.65 |

A hit saves **requests and latency, not Worker CPU**: it still parses the stored answer, and the fakes answer instantly.
On the Free plan (50 subrequests, 10 ms of CPU) the saving is the subrequests of repeated reads. Memory is bounded:
200 entries and 8 MiB per process or isolate.
