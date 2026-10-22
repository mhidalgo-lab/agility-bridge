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

The request, token and grant limits of `agility-bridge serve` apply on Workers too (counters per isolate until P3-04
adds Cloudflare's rate-limiting binding).
