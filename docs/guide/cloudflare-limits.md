# Cloudflare Workers limits

> For the Cloudflare Worker deployment (mode D). How agility-bridge fits each Workers plan, what it hides when a tool
> cannot fit, and where usage shows. Platform figures and sources: [RESEARCH](../RESEARCH.md) (Cloudflare Workers),
> decisions: [ADR-0010](../adr/0010-platform-limits-strategy.md).

## Plans and presets

Set `AB_PLAN` on the Worker (`free` by default):

| | `free` | `paid` |
|---|---|---|
| Agility requests per tool call (`AB_CALL_BUDGET`) | 45 | 1,000 |
| Bytes read from one Agility response (`AB_LIMITS_MAX_RESPONSE_BYTES`) | 512 KiB | 8 MiB |
| Concurrent Agility requests per call | 6 | 6 |
| Ceiling for settings, workspaces and grants | yes (the values above) | no |

Why these numbers:

- **Free** allows 50 external subrequests per request; 45 leaves room for the rest of a request, and a call that would
  need more is never started. Its 10 ms of CPU is the reason for the 512 KiB response cap: reading and shaping
  512 KiB costs about 2–5 ms (P0-09 measurements). On Free the presets are **ceilings**: setting `AB_CALL_BUDGET`
  above 45 or `AB_LIMITS_MAX_RESPONSE_BYTES` above 512 KiB stops the Worker at its first request (it answers `503` and
  logs the setting), and a workspace or grant limit above them is capped (`whoami` shows the effective values).
  With `AB_OTEL_ENDPOINT` set ([observability](observability.md)) each request makes one more outgoing request, for its span, after the response: 45 plus one is still under the 50.
- **Paid** has 10,000 subrequests and seconds of CPU; the presets match `agility-bridge serve`, and workspaces may
  raise or lower them.
- Workers open at most 6 connections at a time per request, so a call runs at most 6 Agility requests in parallel.

## Repeated reads

An optional [query cache](query-cache.md) (`AB_QUERY_CACHE_TTL`) answers repeated reads without Agility requests, which saves subrequests on the Free plan; its sealed Cache API tier (`AB_QUERY_CACHE_EDGE`) adds Cache API calls whose subrequest accounting is *unverified* (P8-13), so it is off unless you set it.

## Tools that cannot fit

Every tool declares the most Agility requests one call can cost ([tool reference](../reference/tools.md)). A tool
whose cost is above the caller's budget is **not listed** in `tools/list` and is refused if called anyway (L-115). The largest declared costs
are `sprint_health` (54) and `standup_summary` (48), the report composites: above the Free budget of 45, so they are listed only
where the budget is larger (Paid, or a raised grant on a self-hosted server); every other read tool declares 30 or less.
**Every write tool fits Free**: the largest is `create_work_item` at 20, then `assign_owners` and `add_comment` at 18, each
the measured worst case on a cold cache plus a margin of 2 to 8 requests (D-199); a workspace or grant with a smaller
budget hides more.

## OAuth endpoints and the D1 write budget

With `AB_OAUTH=on` the public OAuth endpoints are limited by shared counters in D1 ([OAuth abuse controls](../dev/oauth.md#abuse-controls-p5-09)):
every authorization request, consent post and failed token request is one extra D1 row write per counter (two: the
address and the deployment); a request refused by a limit writes nothing, and each isolate remembers a refused counter
until its window ends, so a flood costs about the limit's worth of writes per counter and window, not one per request.
Normal use is a handful of writes per connected app. The Free plan allows 100,000 D1 rows written a day
([RESEARCH](../RESEARCH.md#5-cloudflare-workers-platform)); the default limits keep one flooding address to about 160 writes per ten
minutes (authorize 30, token failures 20 and consent 30, each on two counters) and the deployment-wide caps bound the sum. The cron
sweeps 20 unused registrations per run (one read each, at most 50 D1 queries per run together with the purge).

The panel's **Connected apps** and **OAuth apps** pages (P5-08) read one database row per app they show: ten apps a page, and
the device counts of the OAuth apps page read at most 100 grants (the page says "at least" beyond that, or "unknown" when
the plan's 50 queries per request run out). Revoking a client reads at most 1,000 grants; the client is blocked first, so a
cut-short revoke still refuses everything and pressing it again ends the rest.

## Write tools and the D1 row budget

Write tools ([write tools](write-tools.md)) are small in requests (a write is 5 to 15 Agility requests cold, one of them
the one POST) but they write to D1: the approval ledger and the write limiter live in the `kv` table, and every write is
audited. On the Free plan the limit that matters is the **100,000 D1 rows written a day**, not the 50 subrequests (a
confirmed call makes 5 to 7 D1 queries, a page-approved write about 18 over its four requests, all far below 50 a request).

Rows written per approved write, counting secondary indexes as the D1 documentation describes them (`audit_log` has two, so
an audit row is about three rows; a `kv` insert or delete is two with `kv_expires`). **The index accounting is
unverified**: it is computed from the schema, not read from `meta.rows_written` of a real D1 (P7-30).

| Flow | D1 queries | Rows written (about) |
|---|---|---|
| Dry run, or a read tool (the `tool_call` audit row only) | 1 | 3 |
| Confirmed call, push elicitation (one call: two limiter counters, intent and outcome audit, `tool_call` audit) | 5 | 13 |
| Confirmed call, elicitation by multi round-trip (two calls: ledger round open and take, the same) | 8 | 20 |
| Approval page (the ask, the page, the decision with its admin audit row, the repeated call) | 18 over 4 requests | 31 |

The grant and the denial of a confirmed call are read with **one** statement (`kv.getMany`, P7-30, D-210), and only where
the approval page exists (P7-09, D-200); a read that finds nothing writes nothing, so this saves latency, not rows. The
page flow stays at 18 statements: the first call saves one, the repeat costs one more for the read that lets a limiter
refusal or a conflict keep the approval (P7-28). The deployment-wide cap (`AB_WRITE_RATE_DEPLOYMENT_HOURLY`,
default 200 an hour) bounds the writes, not the rows (with the optional [Durable Object limiter](#exact-limits-on-a-durable-object-optional) the two counters are not D1 rows at all, but the audit rows and the approval ledger still are): a deployment that really sustained 200 page-approved writes an hour
would write about 4,800 x 31 = 149,000 rows a day, **above the Free plan's 100,000**, and the counters, OAuth limits and
read-tool audit rows compete for the same budget. So **on the Free plan (`AB_PLAN=free`, the default) the cap is 60 an hour**:
unset it is 60, and a larger value stops the Worker at its first request, like the call-budget and response-size ceilings
(P7-30, D-211). 60 an hour is at most 1,440 writes and about 45,000 rows a day, under half the budget. One grant at its
default 20 an hour is about 15,000 rows a day. The Paid plan (50 million rows a day included) keeps the default of 200. The `tool_call` audit rows of reads are in the same budget (measured in P9-03: about four rows written per read call, see [per-tool numbers](#per-tool-numbers-on-a-deployed-worker-p9-03)).

## Quotas and the D1 row budget

The optional per-grant [quotas](query-limits.md) (`AB_QUOTA_DAILY`, `AB_QUOTA_MONTHLY`) keep their counters in `kv`: one read when a request first reaches Agility and one statement that adds to every configured period when it ends (2 statements a request, not 3; metadata requests are not counted, so a request that only loaded metadata writes nothing), about 2 more rows written per read call that reaches Agility (the row accounting is *unverified*, as above). On Free that is the difference between about 33,000 and 20,000 read calls a day, so they are off unless you set them.

The write flows above gain the same two statements (one read, one increment for both periods, about 2 rows) when a quota is set,
because a write's POST is counted too: a confirmed call with push elicitation is then 7 statements and about 15 rows. On
Workers the counters are written after the response (`waitUntil`), so they add no latency to the call, only D1 work.

## Tasks and telemetry

[MCP Tasks](tasks.md) cost D1 rows only for the tasks that are used: creating one is 2 statements (the per-grant creation
counter and the sealed record), the poll that runs the report is about 6 (read, lease, read, save, the cancel marker, delete the
lease) plus the tool call's own audit row and quota, so a task is on the order of a dozen rows written (derived from the
schema, *unverified* against `meta.rows_written`; a poll of a finished task is one read). Cancelling is 4 statements. One grant
may start 30 tasks per 15 minutes, which bounds this.

[Self-monitoring](observability.md) uses no D1. Spans are queued per isolate and sent in batches (64 spans, about 128 KiB or five
seconds), after the response, so a request makes at most one outgoing collector request and most make none (D-324); the send is
counted with the Agility requests against the Free plan's 50 only for the request that carries it, and the wait for the age flush
costs no CPU time; spans of requests that never authenticated (401, 429, the public catalogue)
are limited to 30 a minute per isolate and the rest are only counted, so unauthenticated traffic cannot set the number of outgoing
requests (P-3, D-304).

## Where usage shows

- **Audit log**: every tool call's row holds `agilityRequests`, the requests it used (`GET /api/admin/v1/audit`,
  [audit log](audit-log.md)). Budgets never travel in response headers (L-101).
- **`whoami`**: the call's budget (`requestsPerCall`) and the effective limits.
- Exceeding the budget inside a call ends it with `AB_BUDGET_EXHAUSTED` and a hint to narrow the request.

## Measured cost

CPU per request, 2026-10-22 (the panel rows: CI, 2026-10-23, see note 1). *Local*: Node 24 (the same V8 as workerd), `pnpm bench:worker` (medians of warm calls; the
fastest of nine cold boots, after a garbage collection, against the fastest calibration sample), request
isolation as on Workers, Agility-shaped fake responses. *Staging*: `agility-bridge-staging` on the Free plan,
`wrangler tail` CPU time, a synthetic deployment migrated in (no Agility reachable, so no tool call there, D-01).

| Path | Local CPU | Staging CPU | Agility requests |
|---|---|---|---|
| First request of a new isolate, bare boot (settings, keys, D1, key check, admin token, app) | about 70 ms | 20–40 ms (was 60–118 before P3-14) | 0 |
| First `tools/list` of a new isolate (boot and the MCP SDK's first request) | — | 45–86 ms (was 70–129 before P3-14) | 0 |
| `GET /health`, warm | < 1 ms | 0 ms | 0 |
| `tools/list`, warm | about 2 ms | 4–10 ms | 0 |
| `whoami`, warm | about 2.5 ms | — | 1 |
| `search_work_items` (25 rows), warm | about 4 ms | — | 1 |
| `get_work_item`, warm | about 3 ms | — | 2 |
| First `/admin` page of a new isolate (the panel's import and app build, signed in, after the boot) | about 17 ms (6.5×) ¹ | — | 0 |
| `/admin` overview, warm | about 1.3 ms (0.48×) ¹ | — | 0 |
| `/admin/users` (100 users, 25 shown), warm | about 3.7 ms (1.44×) ¹ | — | 0 |
| `/admin/audit` (200 rows, 50 shown), warm | about 3.1 ms (1.18×) ¹ | — | 0 |
| `/admin/assets/<css>`, warm | < 0.1 ms (0.03×) ¹ | — | 0 |
| Form POST (create a user through the in-process admin API), warm | about 0.8 ms (0.3×) ¹ | — | 0 |
| `prompts/list`, warm | about 2 ms (0.5×) | — | 0 |
| `update_status` dry run / approved by elicitation, warm metadata ³ | about 1.6 ms (0.47×) / about 3.1 ms (0.93×) | — | 2 / 4 |
| `update_status` by the approval page, call 1 (ask) / call 2 (apply) ³ | about 1.3 ms (0.40×) / about 2.9 ms (0.87×) | — | 2 / 4 |
| `get_sprint` (worst-case fixture), cold isolate / types from D1 / warm ² | 11 / 7 / 5 ms (2.8× / 1.7× / 1.3×) | — | 17 / 7 / 5 |
| `get_asset_history`, cold / from D1 / warm ² | 4.9 / 2.8 / 2.5 ms (1.2× / 0.7× / 0.6×) | — | 13 / 4 / 2 |
| `get_portfolio_tree`, cold / from D1 / warm ² | 6.7 / 8.1 / 3.4 ms (1.7× / 2.0× / 0.85×) | — | 16 / 7 / 4 |
| `sprint_health`, cold / from D1 / warm ² | 12.8 / 8.7 / 7.4 ms (3.2× / 2.2× / 1.9×) | — | 24 / 8 / 6 |
| `search_work_items`, 25 rows, with deep links, warm | 6.2 ms (1.88×) ⁵ | — | 1 |
| `search_work_items`, 200 rows, with deep links, warm | 12.4 ms (3.77×) ⁵ | — | 1 |
| `search_work_items` with a quota set (2 counter statements), warm | 2.3 ms (0.69×) ⁵ | — | 1 |
| `search_work_items`, telemetry off, warm | 2.4 ms (0.73×) ⁵ | — | 1 |
| `search_work_items`, telemetry on (fake collector, flush each call), warm | 2.9 ms (0.87×) ⁵ | — | 1 |
| Task create (2026-07-28 request, report tool), warm | 1.0 ms (0.29×) ⁵ | — | 0 |
| Task first poll (runs a trivial report), warm | 2.5 ms (0.77×) ⁵ | — | 0 |
| Server build and `tools/list`, Apps views off | 1.7 ms (0.51×) ⁵ | — | 0 |
| Server build and `tools/list`, Apps views on | 1.5 ms (0.45×) ⁵ | — | 0 |
| Public catalogue `tools/list`, no credential, warm | 0.9 ms (0.26×) ⁵ | — | 0 |
| Public catalogue `initialize`, no credential, warm | 0.5 ms (0.16×) ⁵ | — | 0 |
| Six identical parallel reads in one request, query cache off / on (single flight) ⁶ | about 0.4 / 0.6 ms | — | 6 / 1 |
| Shared tier (seal, put, get, open), 8 KB body | 0.7 ms (0.23×) ⁵ | — | 0 |
| Shared tier, 64 KB body | 3.7 ms (1.11×) ⁵ | — | 0 |
| Shared tier, 100 KB body | 6.2 ms (1.87×) ⁵ | — | 0 |
| Shared tier, 256 KB body | 14.7 ms (4.45×) ⁵ | — | 0 |

¹ Panel rows: CPU as measured by the benchmark job on CI (2026-10-23), the same workload on a GitHub-hosted runner, in
milliseconds from the ratio to the run's calibration workload (about 2.6 ms) in brackets. Not the local column: the first
local panel numbers (P4-14) were taken on a loaded machine and overstated the warm pages about threefold.

² Phase 6 tools (P6-39), `pnpm bench:worker`, taken on a machine shared with seven other test runs (load average above 40), so the milliseconds are skewed upward and only the request counts are firm: the worst-case fixtures of the cost test, modules warm, a new `MetadataService`
per call for *cold* (one `meta.v1` request per asset type), the same with the types another isolate stored for *from D1*
(the Worker keeps parsed asset types in D1's `kv` table, D-135), and one service for *warm*. The remaining requests are
not metadata (status lists, the queries themselves). The fixture's metadata is smaller than a real instance's (the
committed snapshot is 228 KB for all types; a live type list parses 1.9 MB), so cold figures understate a real cold call,
and the saving is the requests (here 17 to 7, 13 to 4, 16 to 7, 24 to 8), not only CPU: against D1 the saving in CPU is
smaller and, for `get_portfolio_tree`, within noise. D1 reads are not Agility requests; whether they count toward the Free
plan's 50 subrequests is *unverified*. No Cloudflare measurement of these paths was made (no staging call reaches Agility, D-01).

⁵ Phase 8 paths (P8-37), `pnpm bench:worker`, one run on 2026-10-30 on a shared development machine (calibration
3.3 ms): **local and indicative**, so compare rows of one run with each other, not with the CI history, and
read the first-run figures as noisy. The baseline file is not refreshed from this run (it waits for an idle machine).
What the rows say: deep links make a 25-row search about twice the cost of the old 2-row fixture and the 200-row search
about twice again (P8-40, below); the quota adds 2 counter statements (3 before P8-39) and little CPU; telemetry with a
flush per call adds a few tenths of a millisecond; registering the Apps views is within noise; the public catalogue is
the cheapest MCP path; and the shared tier's seal and open costs milliseconds from 64 KB (P8-38). Agility requests are
counted by the fakes; D1 rows and the deployed Worker are *unverified* until the live pass (P8-13).

⁶ P8-35, `pnpm bench:worker`, local and indicative, one run: with the cache on the six reads share one Agility request (the
saving is the five subrequests, not CPU; the fake answers instantly). The public catalogue rows above are measured after
P8-35, so they are the kept-bytes path: `tools/list` fell from about 0.9 ms (0.26×) to about 0.3 ms (0.08×) and `initialize`
from about 0.5 ms to about 0.1 ms in the same kind of run before and after.

³ Write paths (P7-09), `pnpm bench:worker`: the handler of one write tool on the fakes (no JSON-RPC, no HTTP, no D1), the
item's status toggled between samples. The figures are the quietest of three local runs (the machine was shared, so the
others were two to five times slower); no CI run could record them because the benchmark job failed from P7-04 (the bench
built its registry without `allowNonRead`) until P7-09, so the CI baseline holds these local ratios scaled by 1.35, the
CI/local ratio of the `whoami` row. Storage operations of the approval ledger per call, counted by the benchmark: 0 for the
dry run and the elicitation write, 3 and 1 for the two page calls (the fake page records the grant itself). A write does the
same Agility requests whatever the channel; the cost of `renderApproval` and the SHA-256 of the canonical change is inside
these figures. The approval page and the limiter are in note 4.

⁴ Approval page and limiter (P7-31), `pnpm bench:worker`, one run on a machine shared with other test runs (load average 6 to 11, so
the figures are skewed upward; the CI benchmark job's artifact is the history and compares ratios to its own calibration).
Relative to the calibration workload: the approval page view 0.43, the pending list (five open requests) 0.52, the decision
POST (approve, CSRF, grant, admin audit row) 0.72, and a write by elicitation with the real deployment limiter 1.47 against
1.51 without it in the same run, so the limiter's CPU is within noise. The limiter adds **4 storage statements** to a write
(the deployment counter read, the approval-request unit of P7-27, the grant unit and the deployment unit, all `kv` increments
or reads), counted by the benchmark. CPU is not the cost that matters on D1; the statements and rows are (the table above).

Warm calls fit the Free plan's 10 ms. **The first request of every new isolate does not.** P3-14 moved what does not
depend on the environment to module scope (Workers run it at startup, under a separate limit; startup is about
80–100 ms): the tool registry and the JSON Schemas `tools/list` returns, and the admin API is built only on the first
admin request; the boot derives only the keys in use and routes with a router that needs no compilation. That halved
the cost, but the rest is the boot's crypto and D1 round trips and the MCP SDK building its own protocol schemas on
its first request, which only the SDK can move. Cloudflare has served every such request so far (occasional overruns
are tolerated). The project accepts that on Free (decision D-27 in
[pending decisions](../pending-decisions/phase-3.md)): it is a tolerance, not a guarantee, so if Cloudflare ever
enforces the limit strictly, the first request of a new isolate fails (error 1102, `exceededCpu`) and the client's
retry, served by a warm isolate, succeeds. A deployment that cannot accept that runs on the Paid plan (30 s of CPU),
where it does not matter.

The panel (P4-14) is measured in the same run, signed in as the owner. Its first page of a new isolate (about 17 ms on
CI, 6.5 times the calibration, on top of the boot, which a panel request also pays) imports the panel and builds its app;
like the first MCP request it does not fit the Free plan's 10 ms, and the same tolerance and the Paid-plan answer apply
(D-27). Only an operator opening the panel pays it, never an MCP call (`admin-panel-lazy.test.ts`). A second panel page in
the same isolate costs about 1.1 times the calibration (about 3 ms). **Warm panel pages cost about 1 to 4 ms** and fit the
Free plan's 10 ms: the overview 0.48 times the calibration, the users list about 0.6, the audit viewer about 0.9, an asset 0.03 and a
form POST 0.3. The list screens no longer grow with the number of users (P4-28): the users list asks the admin API for one
page (`limit`, `offset`), and the audit page loads at most 100 users for its filter and the names on the page by id
(`ids`, at most 50), so the cost is bounded at a few hundred users. The figures are for 100 users and 200 audit rows. The benchmark's baseline (`scripts/bench/worker-baseline.json`) compares ratios, not
milliseconds, so a busy machine does not move it. No Cloudflare measurement of the panel was made (no deploy, L-182).

A non-required CI job runs the benchmark on every pull request, keeps the numbers as an artifact and flags a path
whose cost, relative to a calibration workload in the same run, more than doubles against
`scripts/bench/worker-baseline.json`. After an intended change, refresh the baseline with
`pnpm bench:worker --update`.

## Per-tool numbers on a deployed Worker (P9-03)

Measured 2026-11-03 on a Worker deployed on this account's **Free plan** (`agility-bridge-staging`), its D1, and a mock
Agility Worker with synthetic, Agility-shaped data and a modelled delay per upstream request (never a real tenant). The
whole per-tool table (latency p50/p95 on Node stdio, Node HTTP and the Worker, Agility requests cold and warm, Workers
CPU, declared cost against measured worst case) is generated in the [performance reference](../reference/performance.md);
the method is in [Repeat the measurements](#repeat-the-measurements). What the numbers say:

- **Agility requests are the latency.** A warm call is 0 to 5 Agility requests, mostly in sequence, so a tool takes about
  *the longest chain of requests times the upstream's latency* plus 5 to 60 ms of our own work: `whoami` 0.3 s,
  `get_sprint` 1.3 s, `search_work_items` 1.9 s (it sorts by `ChangeDate`, about 1.1 s in P0-06, which the mock models),
  `get_portfolio_tree` and `release_readiness` 2.7 s. Node stdio, Node HTTP and the Worker differ by less than 10% in the
  median; the Worker's p95 is 10 to 30% above its p50. The mock's delays are a model of P0-06's live figures, so **scale
  the latency column to your tenant; the request counts and the CPU are firm.**
- **Warm CPU is above the Free plan's 10 ms for a third of the calls, and Cloudflare did not stop one.** Over 469 warm calls
  of 26 tools, p50 was 6 to 15 ms per tool (`standup_summary`, a report that reads three sections, 31 ms), p95 8 to 24 ms
  (68 ms for one `list_asset_types` call that landed on a new isolate), 155 calls (33%) took more than 10 ms and **none
  ended in an `exceededCpu` error** (`wrangler tail`, `outcome` and `cpuTime`). That is the tolerance of D-27 reaching warm
  calls, not a guarantee (L-097): the Worker's own fixed cost (auth, the audit row, JSON-RPC, shaping) is already 6 to 9 ms in
  `list_teams` and `whoami`, about two to three times the Node figure of `pnpm bench:worker` for the same path. The 512 KiB
  response cap and the call budgets are not what drives this, so they stay (D-356); cutting the fixed cost is P9-15. A
  deployment that cannot accept an occasional error 1102 runs on Paid.
- **D1: about 4 rows written and 1 write query per tool call, 4.5 rows read and 0.8 read queries**, read from the account's
  GraphQL analytics (`d1AnalyticsAdaptiveGroups`, which reports `rowsWritten` and `rowsRead`) for 548 calls: 2,221 rows
  written, 564 write queries, 2,493 rows read, 430 read queries. The audit row of every call is three of the four (the
  table and its two indexes); the rest is the token's last-used time. **On the Free plan a deployment that only reads is
  bounded by D1, not by Worker requests: 100,000 rows a day is about 24,000 tool calls a day, a quarter of the 100,000
  requests** (D-359). This replaces the "about three rows" of the write section; the write flows keep their computed
  figures, which this run did not check.
- **Declared cost covers the measured worst case for every tool** (cold, all 28), with margins of 0 to 15 (most under 6;
  `get_work_item` 23 of 24). The two reports above the Free budget, `sprint_health` (declared 54) and `standup_summary`
  (48), measured 23 and 21 on a cold cache in the cost world, so the budget of 45 hides them behind headroom that may not be
  needed; the declared figures stay until worst-case fixtures with paging prove a lower bound (D-357, P9-16). On a Worker,
  metadata kept in D1 makes a cold isolate cost 5 to 8 requests for the Phase 6 tools instead (table above).
- **Free versus Paid, derived.** Measured: Free. Derived from Cloudflare's current documented limits (fetched 2026-11-03,
  [RESEARCH](../RESEARCH.md#cloudflare-limits-fetched-2026-11-03-p9-03)): on Paid the 10 ms CPU limit becomes 30 s by
  default and the 50 subrequests become 10,000, so no tool here can fail on CPU or subrequests, and the cost becomes money,
  not errors. At the measured p50 of about 10 ms and 4 D1 rows a call, one million tool calls a month use 1 million of the 10
  million requests, about 10 million of the 30 million CPU ms and 4 million of the 50 million D1 rows written that Paid
  includes: the $5 minimum is the bill, and overage prices ($0.30 per million requests, $0.02 per million CPU ms, $1.00 per
  million rows) only matter beyond about 3 million calls a month. These are *derived*; the CPU of the two reports above the Free budget was measured on the same Free account with
  `AB_PLAN=paid` (budget only), so it is a Free-hardware figure.

### Repeat the measurements

Everything is committed. `pnpm bench:worker` measures CPU and requests of every read tool in Node (CI keeps it).
`pnpm bench:latency stdio` and `pnpm bench:latency http` measure latency against the local mock
(`scripts/perf/mock-agility.ts`, `node scripts/perf/mock-agility.ts [port]`). For a Worker, deploy the mock as a Worker
(`spikes/perf-mock`, named `agility-bridge-spike-*`, delete it afterwards), add it as an instance of a staging workspace with
reports and attachment download on (`limits.reports`, `limits.attachmentDownload`), run `bench:latency remote` (it tags each
request `?perf=<tool>:<n>`) while `wrangler tail <name> --format json` writes a capture, and parse the capture with
`node scripts/perf/tail-cpu.ts`; rows come from the D1 analytics for the window. `scripts/perf/collect.ts` writes
`scripts/bench/perf-results.json`, and `pnpm docs:perf` regenerates the reference.

### Regressions

The CI **Worker CPU benchmark** job (not required) flags two things against `scripts/bench/worker-baseline.json`: a path
whose CPU, relative to the run's calibration, is more than twice its baseline, and **any growth in Agility requests** of any
path, since requests are exact. The deterministic part is also a required unit test (`scripts/test/worker-bench.test.ts`):
every read tool's cold and warm request counts must equal the baseline and its cold count must not exceed its declared
cost, so a change that makes a tool send one more request fails the build until the baseline (and the declared cost, if
needed) is updated on purpose (D-360). Introducing the check found that the write paths had grown from 4 to 5 requests
since the baseline (the read-back of P7-19).

## Rate limits

The limits of `agility-bridge serve` (`AB_RATE_LIMIT_*`, [configuration](configuration.md#rate-limits)) apply on
Workers too, counted exactly **per isolate**. Cloudflare runs many isolates, so on their own they are not
deployment-wide (L-081). Three Rate Limiting bindings add a **backstop** across isolates (L-099), declared in
`wrangler.jsonc`:

| Binding | Counts | Default | When it refuses |
|---|---|---|---|
| `RL_IP` | requests per client address (`CF-Connecting-IP`) before authentication | 600 per 60 s | `429` for that address for 60 s in that isolate |
| `RL_AUTH` | failed authentications per address | 20 per 60 s | that address is out of failed attempts for 60 s: more failures get `429` without contacting Agility; valid tokens keep working |
| `RL_OAUTH` | requests per address to `/oauth/authorize`, `/oauth/token`, `/oauth/register` and the consent post (P5-19) | 60 per 60 s | `429` for that address for 60 s in that isolate, before any D1 query of the OAuth abuse counters |

- The local buckets decide first; the binding is asked only when they allow. Bindings count per Cloudflare location
  and are eventually consistent, so they slow an attack down rather than stop it at an exact number.
- A binding that **throws** lets the request through (the local buckets still apply) and logs
  `rate limit binding failed` at most once a minute; a **missing** binding means per-isolate limits only, with a
  warning when the Worker starts. Rate limits never decide authorization.
- An exact deployment-wide limiter (a Durable Object) is an option: [below](#exact-limits-on-a-durable-object-optional).
- `RL_OAUTH` is optional and only matters with `AB_OAUTH=on`. Without it the OAuth routes keep the exact D1 counters
  ([above](#oauth-endpoints-and-the-d1-write-budget)) and the Worker logs one warning at start. It runs after the general
  per-address limit and before the counters, so a request it refuses reads and writes nothing in D1. It is a **backstop**,
  not a second authority (L-099): the D1 counters stay the exact, deployment-wide limit.

### Exact limits on a Durable Object (optional)

The bindings are per location and eventually consistent (L-099). A deployment that needs an exact, deployment-wide count can
add a **Durable Object limiter** (P3-12). It is **off by default**: the bindings stay the default, and nothing changes until
you declare an `RL_SHARED` Durable Object binding. Add this to the Worker's `wrangler.jsonc` (or your local
`wrangler.<name>.local.jsonc`) and deploy:

```jsonc
"durable_objects": { "bindings": [{ "name": "RL_SHARED", "class_name": "SharedLimiter" }] },
"migrations": [{ "tag": "shared-limiter-v1", "new_sqlite_classes": ["SharedLimiter"] }]
```

`new_sqlite_classes` matters: only SQLite-backed Durable Objects exist on the Workers Free plan. The class is exported by
the Worker already; without the binding it is never created.

What it decides, once bound:

| Control | Keys | On Durable Object failure |
|---|---|---|
| Failed authentications (`RL_AUTH`'s limit, T1) | `authfail:<address>` | **fails open**: the binding and the per-isolate buckets decide, one `shared rate limiter failed` warning a minute |
| Sign-in routes (`AB_RATE_LIMIT_*`) and the OAuth routes (`RL_OAUTH`'s limit, T20) | `signin:`, `oauth:` | **fails open**, as above |
| Write counters (grant and deployment, `AB_WRITE_RATE_*`, T31) | `wl:*` | **fails closed**: the write is refused with `AB_WRITE_LIMIT_UNAVAILABLE`, nothing is changed in Agility |

The per-address request limit before authentication (`RL_IP`, every request) and the per-token and per-grant limits stay on
the per-isolate buckets and the binding: asking an object on every request would double the billed requests for little gain.
The per-isolate buckets still run first, so the object is asked only for a request they allow, and an isolate that has
seen a refusal remembers it until it ends, so a flood is turned away without more object calls.

- **Cost:** each call is one billed Durable Object request (the Free plan includes 100,000 a day, Paid 1 million a month, and
  duration charges, see the [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
  A failed authentication that the per-isolate buckets allow is two calls (the count and the check), each OAuth request
  that reaches it one (a connect is about five), and a write three (read the deployment's count, then one increment per counter). Rows are swept by an alarm every 15
  minutes; nothing is written for a refused call except the bucket's time.
- **Sharding:** keys are spread over 16 objects by a hash, so one flooding address does not slow the others' decisions.
  Objects are placed near their first caller; a distant isolate pays the round trip (a call times out after 1.5 s).
- **Exactness:** the object serialises every decision of its shard and uses its own clock, so the limit holds across every
  isolate and location (tested in workerd with two isolates). **Not covered:** a Durable Object is one location, so it is
  not a defence against a distributed flood (use the WAF rule below), and the limits a settings change lowers apply to
  the new bucket size at the next refill.

### Flood measurement for the OAuth routes (P5-19)

Local, in workerd with a synthetic flood (`apps/worker/test/oauth-edge-limit.test.ts`, 2026-11-03): 150 requests to
`/oauth/authorize` from one address. Each unit the abuse counters take is one D1 row write.

| Setup | Requests answered `429` | Counter writes in D1 |
|---|---|---|
| No `RL_OAUTH` (the counters alone: 30 per address and 600 in all per ten minutes) | 120 | 60 (30 on the address counter, 30 on the deployment's) |
| `RL_OAUTH` at 5 per 60 s (test value) | 145 | 10; after the binding refuses, none |

The shipped limit (60 per 60 s) is deliberately **looser** than the address counter (30 per ten minutes): one address that
floods is already bounded by the counters at about 60 writes per ten minutes, so a binding at 60 a minute saves no writes
for it. What the binding saves is the *queries*: each isolate that has not yet seen a refusal asks D1 once more before it
remembers it, and a flood spread over many isolates repeats that. Lower `limit` in `wrangler.jsonc` (or use the WAF rule
below) to cut writes harder; a normal connect is about five requests. The figures are a model of a flood, not a Cloudflare
measurement (no deploy, L-182); no real service was probed.

### A WAF rate limiting rule for the OAuth routes

A deployment that owns the zone can stop a flood before the Worker runs at all, which also saves the Worker request
(100,000 a day on Free): in the zone's **Security > WAF > Rate limiting rules** add a rule

- *When incoming requests match*: `starts_with(http.request.uri.path, "/oauth/")` (this also covers
  `/.well-known/oauth-*` if you extend it with an `or`), method `GET` or `POST`;
- *With the same*: IP address; *Requests*: 30; *Period*: 10 seconds (the periods your plan offers; Free zones have one rule
  and a fixed 10 second period);
- *Then*: Block, for 10 seconds to 1 minute.

Keep the rule per address, never one counter for the whole zone (that would let anyone lock every client out, T20), and keep
the `/w/*/mcp` paths out of it. The Worker's own limits still apply after it. Rules and plan limits change: check the
[Cloudflare rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) page; this recipe is
*unverified* on a real zone.

Deep links after P8-40 (local and indicative, 2026-10-30, a machine with a high load average, calibration 3.3 ms): the
25-row and 200-row searches took 4.0 ms (1.35×) and 11.3 ms (3.80×), so a row of the whole pipeline costs about 40 µs, most
of it shaping and serialising. The link's own share is measured separately, with the instance URL parsed once per result and no second parse per
link: about 1.2 µs a row against 3.4 µs before (200 rows, 1,000 repeats, same machine). A result's links add at most 24,000 characters ([output
formats](output-formats.md)). Only the micro-measurement is under a few microseconds; the bench rows cannot show it
because the links are a small part of a row, so that criterion of P8-40 stays unchecked until an idle-machine run.
