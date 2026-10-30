# Query limits and quotas

> How much one tool call, one connection and one day may ask of Agility, and what the deployment does about it
> (ADR-0010, P8-09). The Agility tenant's own request quota is shared by everyone behind it, so these limits protect it
> before Agility does.

## The layers

| Layer | Scope | Where it is set | When it trips |
|---|---|---|---|
| Request budget | one tool call | `AB_CALL_BUDGET` (Free plan 45, otherwise 1,000), a workspace or a grant | `AB_BUDGET_EXHAUSTED`, the call ends |
| Concurrency and circuit breaker | one credential | built in | calls wait, or `AB_AGILITY_RATE_LIMITED` |
| Rate limits | per IP, token and grant per minute | `AB_RATE_LIMIT_*` | HTTP 429 |
| **Quota** | one grant, per UTC day and per UTC month | `AB_QUOTA_DAILY`, `AB_QUOTA_MONTHLY` | `AB_LIMIT_QUOTA` on a read |
| Write limit | one grant and the deployment, per hour | `AB_WRITE_RATE_*` | `AB_LIMIT_RATE` ([write tools](write-tools.md)) |

## Quotas

Off unless you set a number. `AB_QUOTA_DAILY=2000` lets each grant cause at most 2,000 Agility requests a UTC day;
`AB_QUOTA_MONTHLY=40000` caps the UTC month. Both can be set; either one ends the reads. The same numbers apply to every
grant of the deployment, and each grant has its own counters (a pass-through workspace has one counter shared by its
callers). A per-grant or per-workspace override is [P8-14](../tasks/phase-8-power-features/P8-14-quota-overrides.md).

**What counts.** Each request the server sends to Agility counts once, at its first attempt: a retry is not a second
one, and an answer from the [query cache](query-cache.md) is none (L-116). Metadata requests count: a cold isolate loads
about a dozen asset types in a first call (on Workers they are kept in D1 afterwards). A write's POST counts.

**What happens at the limit.** A read that would pass it is refused before anything is sent, with the error
`AB_LIMIT_QUOTA`, the period, the limit, what was used and the UTC instant the counter restarts. It is an ordinary tool
error (the connection keeps working for tools that need no request), not an HTTP `429`. A write's POST is counted but not
refused by the quota: writes have their own hourly limit and an approval, and a write the person already approved should
not die on a read quota. A call stops in the middle when it reaches the limit: its earlier requests stay counted.

**Warning at 80%.** `whoami` shows `quota` (used, limit, remaining, `resetsAt`, `warning`) and a note once a period is at
or above 80%; the grant page of the admin panel shows "Agility requests"; the server logs `grant quota reached 80%` once
per period, in the request that crosses it. The admin API has `GET /api/admin/v1/grants/{id}/usage` (an owner or admin
any grant, a member only their own).

**Fail-open on a counter outage.** The counters live in the storage `kv` table. When they cannot be read the request
goes ahead, the outage is logged (`quota counters could not be read`) and `whoami` and the panel say `unknown`, never
"unlimited"; a failed increment loses that request's count (`quota counters could not be updated`). This is the opposite of
the write limiter, which fails closed because a limiter that opens on failure would not limit writes (L-080); a quota is
a cost control, and blocking every read when D1 hiccups would hurt more than a few uncounted requests. Counters are
approximate under concurrency: a request is checked against what the others had written when it started, so several
simultaneous requests of one grant can overshoot by at most the calls they were already making.

Quotas apply to the remote hosts (`serve` and the Worker). `agility-bridge stdio` has no grants and no shared store.

## What it costs in storage (Workers Free: 100,000 D1 rows written a day)

A request touches the counters at most three times, and not at all when it never reaches Agility (a cache hit, a
refusal by the access model, `tools/list`):

| When | D1 statements | Rows written (about) |
|---|---|---|
| First upstream call of a request | 1 read (`getMany`, both counters) | 0 |
| The end of a request that made calls, per configured period | 1 increment each | 1 (an update; 2 for the first request of a day or month: the row and its expiry index) |
| `whoami` and the grant page | 1 read | 0 |

So a read tool call that reaches Agility costs about 2 more rows than without a quota (both periods set; 1 with one) on
top of the 3 rows of its `tool_call` audit row, and the first call of each grant each day and month 4 more.
At the Free plan's 100,000 rows that is about 20,000 read calls a day instead of 33,000; the Paid plan is not
constrained. **The row accounting is computed from the schema, not read from a real D1 (`meta.rows_written`): unverified,**
like the write numbers in [Cloudflare limits](cloudflare-limits.md). A quota is a cost control you opt into: set it where
the Agility tenant needs protecting, and leave it off on a small Free deployment.
