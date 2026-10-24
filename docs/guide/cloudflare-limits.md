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
- **Paid** has 10,000 subrequests and seconds of CPU; the presets match `agility-bridge serve`, and workspaces may
  raise or lower them.
- Workers open at most 6 connections at a time per request, so a call runs at most 6 Agility requests in parallel.

## Tools that cannot fit

Every tool declares the most Agility requests one call can cost ([tool reference](../reference/tools.md)). A tool
whose cost is above the caller's budget is **not listed** in `tools/list` and is refused if called anyway (L-115). All
tools fit the Free budget today (the largest declares 24); a workspace or grant with a smaller budget hides more.

## OAuth endpoints and the D1 write budget

With `AB_OAUTH=on` the public OAuth endpoints are limited by shared counters in D1 ([OAuth abuse controls](../dev/oauth.md#abuse-controls-p5-09)):
every authorization request, consent post and failed token request is one extra D1 row write per counter (two: the
address and the deployment); a request refused by a limit writes nothing, and each isolate remembers a refused counter
until its window ends, so a flood costs about the limit's worth of writes per counter and window, not one per request.
Normal use is a handful of writes per connected app. The Free plan allows 100,000 D1 rows written a day
([RESEARCH](../RESEARCH.md#cloudflare-workers)); the default limits keep one flooding address to about 160 writes per ten
minutes (authorize 30, token failures 20 and consent 30, each on two counters) and the deployment-wide caps bound the sum. The cron
sweeps 20 unused registrations per run (one read each, at most 50 D1 queries per run together with the purge).

The panel's **Connected apps** and **OAuth apps** pages (P5-08) read one database row per app they show: ten apps a page, and
the device counts of the OAuth apps page read at most 100 grants (the page says "at least" beyond that, or "unknown" when
the plan's 50 queries per request run out). Revoking a client reads at most 1,000 grants; the client is blocked first, so a
cut-short revoke still refuses everything and pressing it again ends the rest.

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

¹ Panel rows: CPU as measured by the benchmark job on CI (2026-10-23), the same workload on a GitHub-hosted runner, in
milliseconds from the ratio to the run's calibration workload (about 2.6 ms) in brackets. Not the local column: the first
local panel numbers (P4-14) were taken on a loaded machine and overstated the warm pages about threefold.

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
Free plan's 10 ms: the overview 0.48 times the calibration, the users list 1.44, the audit viewer 1.18, an asset 0.03 and a
form POST 0.3. The two list screens grow with the number of users (each makes admin API calls that parse the whole user
list, and the audit page also loads every workspace and user to show names): the figures are for 100 users and 200 audit
rows, and the follow-up is P4-28. The benchmark's baseline (`scripts/bench/worker-baseline.json`) compares ratios, not
milliseconds, so a busy machine does not move it. No Cloudflare measurement of the panel was made (no deploy, L-182).

A non-required CI job runs the benchmark on every pull request, keeps the numbers as an artifact and flags a path
whose cost, relative to a calibration workload in the same run, more than doubles against
`scripts/bench/worker-baseline.json`. After an intended change, refresh the baseline with
`pnpm bench:worker --update`.

## Rate limits

The limits of `agility-bridge serve` (`AB_RATE_LIMIT_*`, [configuration](configuration.md#rate-limits)) apply on
Workers too, counted exactly **per isolate**. Cloudflare runs many isolates, so on their own they are not
deployment-wide (L-081). Two Rate Limiting bindings add a **backstop** across isolates (L-099), declared in
`wrangler.jsonc`:

| Binding | Counts | Default | When it refuses |
|---|---|---|---|
| `RL_IP` | requests per client address (`CF-Connecting-IP`) before authentication | 600 per 60 s | `429` for that address for 60 s in that isolate |
| `RL_AUTH` | failed authentications per address | 20 per 60 s | that address is out of failed attempts for 60 s: more failures get `429` without contacting Agility; valid tokens keep working |

- The local buckets decide first; the binding is asked only when they allow. Bindings count per Cloudflare location
  and are eventually consistent, so they slow an attack down rather than stop it at an exact number.
- A binding that **throws** lets the request through (the local buckets still apply) and logs
  `rate limit binding failed` at most once a minute; a **missing** binding means per-isolate limits only, with a
  warning when the Worker starts. Rate limits never decide authorization.
- An exact deployment-wide limiter (a Durable Object) is planned as an option (P3-12).
