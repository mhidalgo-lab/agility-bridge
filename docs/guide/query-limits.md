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
callers).

**Lower it for one workspace or grant.** A workspace and a grant can carry their own `limits.quota` (`daily`,
`monthly`; whole numbers). The quota that applies is the **lowest** of the server's, the workspace's and the grant's, per
period, so an override can only lower: a value above the server's is refused (`422`, naming the server's value) and one
that is stored anyway (a restored backup, or the server's value lowered later) still resolves to the lowest. A period the
server leaves unlimited can be limited by an override. Anyone who may edit the workspace or grant can add or lower a
quota; **raising or removing** one that is set needs an owner with a recent sign-in, so an administrator cannot undo what
an owner decided. Set it in the panel (the Limits fields of the workspace and grant forms), in the admin API
(`limits.quota` on `POST` and `PATCH` of `/workspaces` and `/grants`) or with `--quota-daily` and `--quota-monthly` of
`agility-bridge workspace add|set` and `grant add`. `whoami` and the grant page show the limit that applies. The quota
is not a scope dimension: the access cache and the query cache keys do not change.

**What counts.** Each request the server sends to Agility counts once, at its first attempt: a retry is not a second
one, and an answer from the [query cache](query-cache.md) is none (L-116). **Metadata requests do not count** (D-316):
a cold isolate loads about a dozen asset types in a first call (on Workers they are kept in D1 afterwards), which would
drain a small quota faster than the caller's own use. Only data queries and writes count; a metadata request is still
refused once a period is used up, and the call's request budget still bounds how many of them one call may make. A
write's POST counts.

**What happens at the limit.** A read that would pass it is refused before anything is sent, with the error
`AB_LIMIT_QUOTA`, the period, the limit, what was used and the UTC instant the counter restarts. It is an ordinary tool
error (the connection keeps working for tools that need no request), not an HTTP `429`. A write's POST is counted but not
refused by the quota: writes have their own hourly limit and an approval, and a write the person already approved should
not die on a read quota. A call stops in the middle when it reaches the limit: its earlier requests stay counted. A
refused read costs nothing else either: it spends no unit of the call's request budget and is not reported as a request
that reached Agility (the quota is asked before the budget is spent, D-299).

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
simultaneous requests of one grant can overshoot. The bound is the requests of that grant in flight at once times the
calls each may still make (its call budget, 45 on Workers Free): a quota is a **soft cap**, not a reservation (D-296). On
Workers the total is written after the response (D-295), so a request that starts in the first moments after another ends
can still read the old count. A hard cap would need an atomic reservation per call, which is a D1 write per Agility
request (the budget this design exists to save, L-415).

Quotas apply to the remote hosts (`serve` and the Worker). `agility-bridge stdio` has no grants and no shared store.

## What it costs in storage (Workers Free: 100,000 D1 rows written a day)

A request touches the counters at most twice, and not at all when it never reaches Agility (a cache hit, a
refusal by the access model, `tools/list`). A request that made only metadata requests reads once and writes nothing:

| When | D1 statements | Rows written (about) |
|---|---|---|
| First upstream call of a request | 1 read (`getMany`, both counters) | 0 |
| The end of a request that made counted calls | 1 statement that adds to both periods (`incrementMany`, D-317) | 1 per configured period (an update; 2 for the first request of a day or month: the row and its expiry index) |
| `whoami` and the grant page | 1 read | 0 |

One statement for both periods saves a D1 round trip (2 statements a request instead of 3), not rows: D1 counts the
rows an upsert writes, so the rows below are the same as with one statement per period. What saves rows is that metadata is
not counted. So a read tool call that reaches Agility costs about 2 more rows than without a quota (both periods set; 1 with one) on
top of the about 4 rows a read call writes (its `tool_call` audit row and the token's last-used time, measured on a deployed
Worker in P9-03), and the first call of each grant each day and month 4 more.
At the Free plan's 100,000 rows that is about 16,000 read calls a day instead of 24,000; the Paid plan is not
constrained. The 4 rows of a read call are **measured** (D1 analytics, 2026-11-03); the 2 rows of the counters are still
computed from the schema, **unverified**, like the write numbers in [Cloudflare limits](cloudflare-limits.md). A quota is a cost control you opt into: set it where
the Agility tenant needs protecting, and leave it off on a small Free deployment.

## Declared cost against the measured worst case (P9-03)

Every tool declares the most Agility requests one call can make, and the call budget (45 on Workers Free, otherwise 1,000)
hides a tool whose declared cost does not fit (L-114, L-115). The cost test (`packages/core/test/tools/cost.test.ts`) forces
each tool's worst-case fixture on a cold metadata cache and asserts requests <= declared; `pnpm bench:worker` records the
same counts, cold and warm, in `scripts/bench/worker-baseline.json`, and a test pins them (any change is deliberate). The
table of all 28 read tools, with the measured latency per mode, is the [performance reference](../reference/performance.md).

What the 2026-11-03 measurements say about budgets and caps (decisions D-356 and D-357 in
[pending decisions](../pending-decisions/phase-9.md)):

- **No tool exceeds its declared cost**, and a warm call is 0 to 5 requests, so the budget of 45 is generous for everything
  that fits; nothing was lowered. A tool that sends one more request than before fails the baseline test.
- **`sprint_health` (54) and `standup_summary` (48) are declared well above their measured 23 and 21** and are hidden on
  Free by the budget of 45. They stay as declared: the fixture is not a worst case (no paging), and a lower declared cost
  that is later wrong would break the budget guarantee on Free. P9-16 builds the worst case that proves the real bound.
- **Quota and rate defaults are not changed**: a quota counts requests (1 to 5 per call warm), not tools, and the
  measured requests per call agree with how the defaults were reasoned in ADR-0010.
