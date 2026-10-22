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
