# Pending decisions — Phase 3

> Open questions and owner steps from Phase 3. Answer inline (`**Owner:** …` with a date).

## Owner steps

1. **Custom domain** (P3-07): when you want a stable address, run
   `pnpm cf:setup --name agility-bridge-staging --domain <host in one of your zones>` and add the WAF skip rule for
   `/w/*/mcp` from the [deploy guide](../guide/cloudflare-deploy.md#a-custom-domain); then connect one MCP client to
   it. Until then the deployment answers on `workers.dev` only.
2. **An Agility credential on the Worker** (P3-07): a real tool call on staging needs an Agility token. The third-party
   tenant is read-only and reached only through the live guard (D-01), so a staging credential needs a tenant you own
   or explicit permission; until then staging holds only synthetic data.
3. **Client runs over HTTPS**: connect VS Code, JetBrains, Copilot CLI, Claude Code and Cursor to the staging Worker
   (`https://agility-bridge-staging.<subdomain>.workers.dev/w/bench/mcp`, the migrated synthetic workspace, a device
   token from `agility-bridge token issue` through the admin API) and record the versions in the client matrix. MCP
   Inspector CLI 2.11.0 is verified in both eras.
4. **Staging secrets file**: back up `~/.config/agility-bridge/staging.secrets` (master key and admin token of
   `agility-bridge-staging`) the way you keep master keys.

## Open decisions

### D-27 — The Worker's cold start and the Free plan *(P3-10, P3-14)*
- **Context:** warm requests use 4–10 ms of CPU, within the Free plan's 10 ms. The first request of each new isolate
  uses 20–40 ms (bare boot) or 45–86 ms (the first MCP request), down from 60–129 ms after P3-14. Cloudflare has
  served all of them (overruns are tolerated, not guaranteed). What is left is the boot's crypto and D1 round trips and
  the MCP SDK building its protocol schemas on its first request, which our code cannot move (L-097).
- **Options:** (a) production on **Workers Paid** (5 USD a month; 30 s of CPU per request), staging stays on Free;
  (b) stay on Free and accept that a cold start may one day be refused (error 1102) until isolates warm up; (c) ask
  the MCP SDK maintainers for an eager or warmable protocol-schema build (a public issue), then measure again.
- **Recommendation:** (a) for any deployment people depend on, with (c) as a follow-up; Free stays fine for trying
  agility-bridge out. P3-14 stays blocked on this decision.
- **Owner (2026-10-22):** Decided: (b), stay on Free and accept the cold-start overrun as a documented, tolerated
  risk (as relic-bridge does). P3-14 closes with the criterion changed; warm calls keep the 10 ms budget. Paid stays
  the documented way out for anyone who cannot accept it.

### D-28 — Go for Phase 4 *(P3-11)*
- **Context:** the [Phase 3 review](../reviews/phase-3-review.md) found no high issue; two medium and five low ones are
  fixed with mutation-checked regression tests. The Worker runs on staging, the smoke checks and MCP Inspector pass over
  HTTPS. Open: D-27 (cold start on Free), P3-12 (optional exact limiter), the owner's client runs.
- **Options:** (a) go for Phase 4 now; (b) go after D-27 is decided and the clients are verified; (c) hold.
- **Recommendation:** (a): Phase 4 (identity and the admin panel) does not depend on D-27, which only matters for a
  production deployment on the Free plan.
- **Owner (2026-10-23):** Decided: (a), go for Phase 4 now.

### D-339 — The Durable Object limiter decides the sensitive keys and the write counters, not every request *(P3-12)*
- **Context:** an exact limiter is billed per call (a Durable Object request), and the Free plan has 100,000 of them a day, as many as
  Worker requests. Asking it for the per-address limit on every request would double the billed requests of a busy deployment.
- **Options:** (a) the object decides `authfail:`, `signin:` and `oauth:` request keys and the write counters; the per-address request
  limit (`ip:`) and the per-token and per-grant limits keep the per-isolate buckets and the `RL_IP` binding; (b) every key goes to the
  object when it is bound; (c) a setting lists the keys.
- **Recommendation:** (a). These are the limits where "more than the limit across isolates" is a security failure (guessing, sign-in
  and registration floods, write budgets); the per-request limits are throughput protection where an eventually consistent backstop is
  enough. (c) is a small follow-up if an operator needs another set.
- **Owner (2026-11-03):** Decided: as recommended, (a).

### D-340 — A broken object falls back to the backstop for request limits and refuses writes *(P3-12)*
- **Context:** the task fixes the policy (fail open for request limits, closed for writes). What "open" means when a binding is also
  present is not stated: let everything through, or fall back to the weaker limit.
- **Options:** (a) fall back to the Rate Limiting binding and the per-isolate buckets, and log once a minute; (b) let the request through
  with no limit; (c) fail closed for authentication failures too.
- **Recommendation:** (a): the weaker protection that was the default before is exactly what an operator keeps while the object is down,
  nothing blocks a valid caller, and a flood during an outage is still slowed. Write counters throw, so the write limiter refuses the
  write (`AB_WRITE_LIMIT_UNAVAILABLE`), as it does for a failing D1.
- **Owner (2026-11-03):** Decided: as recommended, (a).

