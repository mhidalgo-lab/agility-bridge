# P0-08 results: OAuth 2.1 on Workers and Node with one protected resource per workspace

Date: 2026-10-21. Status: **local results done (workerd and Node); production deploy and real clients pending** (the
462 KB bundle needs `wrangler` logged in to the owner's Cloudflare account; see *Deploy* below).

Versions: `@cloudflare/workers-oauth-provider` **1.2.3** (latest, 13 days old), `@modelcontextprotocol/server` 2.3.1,
wrangler 4.149.0 (local workerd), Node 24.16.0. This spike starts from relic-bridge's P0-08 spike (same maintainer, same
provider; its results: provider verdict "go", deployed and used by Claude Code and GitHub Copilot) and adds what
agility-bridge's task asks for.

## What differs from relic-bridge's spike

| | relic-bridge | agility-bridge |
|---|---|---|
| Resource URL | `/p/{slug}/mcp` | `/w/{slug}/mcp` (one protected resource per workspace, RFC 9728 + RFC 8707) |
| Workspace list | module memory (its runtime-added project failed in production: another isolate did not see it) | **KV storage**, read on every request |
| Unknown workspace | 404 (reveals which workspaces exist) | **same 401 challenge as a missing token** (T19) |
| Runtime admin endpoint | open | needs the `SPIKE_ADMIN` secret |
| CIMD fetch failure | 500 | 400 |
| Concurrent refresh | not tested | **tested** (§2) |

## 1. End-to-end checks (`scripts/e2e.ts`), local workerd and Node

All checks pass on both runtimes (Node with `NODE_CIMD=1`, which installs the strict-public fetch guard):

- 401 without a token, with `WWW-Authenticate: Bearer … resource_metadata="…/.well-known/oauth-protected-resource/w/team/mcp"`;
  an **unknown workspace gets the identical challenge** (T19).
- Per-workspace protected resource metadata; authorization server metadata with PKCE `S256` only, RFC 9207 `iss`,
  CIMD advertised, both workspaces in `protected_resources`.
- DCR (public client, 201); authorize with PKCE; `iss` in the authorization response; token names the resource.
- The `whoami` tool sees a grant bound to `team`; **the team token is rejected at `/w/ops/mcp`** (RFC 8707); a second
  grant for `ops` does not revoke the first.
- Refresh **cannot retarget** (`invalid_target`); refresh rotates; the new access token works.
- Unknown resource at authorize is refused; PKCE `plain` and missing PKCE are refused.
- **Storage, not isolate memory:** a workspace added at runtime (admin secret required; a wrong secret gets 403) works
  on 30 of 30 later requests, and existing tokens stay valid.
- Revocation (RFC 7009) accepted; the revoked access token gets 401.

`scripts/cimd.ts` passes on both runtimes with **Claude Code's real client metadata document**
(`https://claude.ai/oauth/claude-code-client-metadata`, fetched by the server): loopback redirects on `127.0.0.1` and
`localhost` with any port; a redirect URI outside the document gets 400.

## 2. Concurrent refreshes (L-029, L-164)

Five refreshes with the same refresh token, in parallel, on a dedicated client (identical on workerd and Node):

| Observation | Result |
|---|---|
| Refresh requests that succeeded | **5 / 5**, five distinct new refresh tokens |
| New access tokens that work | **5 / 5** |
| New refresh tokens still usable after the race | **1 / 5** (the last one written) |
| The original refresh token after a new one was used | 400 |

The provider never revokes the grant, but it keeps only the last refresh token written. A client that kept any of the
other four loses the grant at its next refresh and must sign in again. ADR-0009 promises a bounded reuse interval
(default 30 s) for concurrent refreshes; **the provider does not implement one**, so P5-05 needs a wrapper (a
per-grant refresh family in storage that answers repeats within the interval with the same successor) and must prove
it with this test.

## 3. Unchanged from relic-bridge's measurements

KV operations per step (DCR 1 put; authorize 2 get + 1 put + 1 list; code exchange 2 get + 2 put; MCP request 1 get;
refresh 2 get + 2 put), the Workers Free KV write budget (1,000 per day: refreshes dominate), the Node adapters
(`cloudflare:workers` shim, KV over `node:sqlite`, the CIMD SSRF guard with its DNS-rebinding gap that production closes
at connect time), and the per-request construction of the authorization and resource servers. Same library version
line; not re-measured.

## Deploy (pending the owner)

The Worker bundle is 462 KB minified (124 KB gzip). Uploading it through the Cloudflare API tool is not practical, so the
deploy uses wrangler:

```sh
cd spikes/oauth && pnpm install
pnpm exec wrangler login                         # once, in the owner's own terminal (browser sign-in)
pnpm exec wrangler kv namespace create agility-bridge-spike-oauth-kv   # put the id in a git-ignored wrangler.deploy.jsonc
pnpm exec wrangler deploy -c wrangler.deploy.jsonc
pnpm exec wrangler secret put SPIKE_ADMIN -c wrangler.deploy.jsonc
SPIKE_ADMIN=… node scripts/e2e.ts https://agility-bridge-spike-oauth.<subdomain>.workers.dev
node scripts/cimd.ts https://agility-bridge-spike-oauth.<subdomain>.workers.dev
```

Then the real clients (owner): Claude Code (`claude mcp add --transport http …/w/team/mcp`, then `/mcp` → authenticate),
VS Code (`"type": "http"` without headers), MCP Inspector CLI (OAuth flags). claude.ai web and Claude mobile need custom
connectors on the account (not available on relic-bridge's run). Teardown: delete the Worker and the KV namespace.

## Reproduce locally

```sh
cd spikes/oauth && pnpm install
printf 'SPIKE_ADMIN=local-spike-admin\n' > .dev.vars          # git-ignored
pnpm dev:worker &                                             # http://127.0.0.1:8797
SPIKE_ADMIN=local-spike-admin NODE_CIMD=1 PORT=8798 pnpm dev:node &
SPIKE_ADMIN=local-spike-admin pnpm e2e http://127.0.0.1:8797
SPIKE_ADMIN=local-spike-admin pnpm e2e http://127.0.0.1:8798
pnpm cimd http://127.0.0.1:8797
```
