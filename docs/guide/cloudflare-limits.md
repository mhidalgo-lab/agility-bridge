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

## Where usage shows

- **Audit log**: every tool call's row holds `agilityRequests`, the requests it used (`GET /api/admin/v1/audit`,
  [audit log](audit-log.md)). Budgets never travel in response headers (L-101).
- **`whoami`**: the call's budget (`requestsPerCall`) and the effective limits.
- Exceeding the budget inside a call ends it with `AB_BUDGET_EXHAUSTED` and a hint to narrow the request.

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
