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
3. **Staging secrets file**: back up `~/.config/agility-bridge/staging.secrets` (master key and admin token of
   `agility-bridge-staging`) the way you keep master keys.
