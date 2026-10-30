---
id: P8-09
title: Per-grant quotas and usage
phase: 8
status: in-progress
priority: low
depends_on: [P6-13]
adr: ["0010"]
lessons: [L-116, L-080]
owner: "agent (lane A)"
---

# P8-09 — Per-grant quotas and usage

## Goal
Protect the customer's Agility tenant over days, not only per call.

## Scope
- **What is counted:** logical Agility requests, per grant: every call the Agility client sends counts once at its first attempt (a retry is not a second one, L-116), a hit in the query cache (P8-01) counts none, a write's POST counts. Per UTC day and per UTC month.
- **Settings** (remote hosts; stdio has no grants and no shared store): `AB_QUOTA_DAILY` and `AB_QUOTA_MONTHLY`, requests per grant, each off when unset (D-247). The error code `AB_LIMIT_QUOTA` already exists in the contract and is used for the refusal.
- **Enforcement:** inside the Agility client, before a read is sent (a tool-error `AB_LIMIT_QUOTA` with the period, limit, used and reset instant; nothing is asked of Agility). A write's POST is counted but not refused by the quota (its own hourly limit and approval apply, D-249). One refusal is a normal tool error, not an HTTP 429 (D-250).
- **Counters:** the storage `kv` table (so every isolate and replica agrees), keys `qt:d:<grant>:<YYYYMMDD>` and `qt:m:<grant>:<YYYYMM>`. To respect the Workers Free D1 row budget a request touches them at most three times: one `getMany` when its first upstream call is about to happen and one increment per configured period when the call ends (D-248). Requests that are all cache hits touch nothing.
- **Fail open:** an unreadable counter is logged and lets the work go on (`whoami` and the panel say `unknown`, never "unlimited"); an increment that fails loses that request's count. Documented as the opposite of the write limiter (fail closed, L-080).
- **Visibility:** warning at 80% (a note in `whoami`, a `warning` flag, and one `grant quota reached 80%` log line per period when a request crosses it); `whoami` carries `quota` with used, limit, remaining and the UTC reset; the admin API `GET /grants/{id}/usage` (owner and admin any grant, a member only their own) and a row "Agility requests" on the grant page of the panel.
- **Docs:** `docs/guide/query-limits.md` (new) with the D1 row cost of the quota; THREAT_MODEL T5 and A10.

## Acceptance criteria
- [x] Quota tests: counting (logical, retries once, cache hits none), refusal before any upstream call, UTC day and month rollover, per-grant isolation, 80% warning, concurrent requests of one grant, **counter outage fails open** (read and increment), garbage counter values.
- [x] Negative authorization tests: a refused request makes no upstream call and returns no data; another grant's quota is untouched; `GET /grants/{id}/usage` hides another member's grant (404) and answers nothing without a session.
- [x] `whoami` and the grant page show the usage; the admin API reference and the contract are regenerated.
- [x] The row cost per request is documented (and marked unverified like P7-30's accounting) in `docs/guide/query-limits.md` and `docs/guide/cloudflare-limits.md`.
- [ ] Per-grant overrides of the limits (a grant's own lower quota through the admin API, CLI and panel) and a workspace-level quota: left for P8-14.

## Security notes
THREAT_MODEL T5 (agents exhausting the customer's Agility tenant) and A10 (revoked or abused credentials): quotas are enforced on the server side per grant, a caller cannot widen them, and counters hold no request data (T21).

## Lessons applied
- L-116 — Quotas count logical upstream calls.
- L-080 — Decide fail-open vs fail-closed for each control, and test it.

## Docs to update
- docs/guide/query-limits.md (new)
- docs/guide/cloudflare-limits.md, docs/guide/configuration.md, docs/reference/admin-api.md (generated)

## Out of scope
- Per-grant or per-workspace limit overrides (P8-14).
- A quota on stdio.
- Billing or reporting exports of usage.
