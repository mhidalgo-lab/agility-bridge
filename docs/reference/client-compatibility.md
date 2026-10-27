# MCP client compatibility

> Status: **documented, partly verified** (2026-10-20). Cells come from vendor documentation, changelogs or forums
> (sources at the end) unless marked **V**: P0-07 verified MCP Inspector against the agility-bridge spike, and carried
> over two clients from relic-bridge's spike with the same SDK (see *Verified so far*). Verification happens in P0-07
> (stdio and HTTP, both protocol eras), P5-06 (OAuth) and every phase review. A verified cell records the client version
> and the date ([ADR-0016](../adr/0016-mcp-client-support.md), L-023).

Legend: ✅ documented support · ❌ documented or strongly implied absence · ? unknown · **V** verified with
agility-bridge (version, date).

## Primary clients

| Client | Protocol eras | stdio | Streamable HTTP | Static headers | OAuth 2.1 | Elicitation | MCP Apps | Tasks | Prompts / resources | Tool cap |
|---|---|---|---|---|---|---|---|---|---|---|
| GitHub Copilot in VS Code | 2026-07-28 on stdio and HTTP (**V** 2026-10-20; documented as ≤ 2025-11-25 before) | ✅ | ✅ | ✅ (`headers`) | ✅ DCR + CIMD | ✅ form | ✅ | ❌ | ✅ / ✅ | 128 per request |
| GitHub Copilot in JetBrains IDEs | 2025 era over HTTP (**V** 2026-10-20) | ✅ | ✅ | ✅ (`requestInit.headers`) | ✅ DCR (preview) | ✅ form | ❌ | ❌ | ✅ / ✅ | ? |
| GitHub Copilot CLI | 2026-07-28 (v1.0.81; **V** 1.0.87 stdio + HTTP) | ✅ | ✅ | ✅ | ✅ DCR + CIMD + device code | ✅ form + URL | ❌ | ❌ | ? / ? | none (lazy loading) |
| Claude Code | 2026-07-28 (v2.1.292) | ✅ | ✅ | ✅ | ✅ DCR + CIMD | ✅ form + URL | ✅ | ? | ✅ / ✅ | none (tool search) |
| Claude Desktop | via Code tab / connectors | ✅ (`.mcpb` extensions, config file) | ✅ (connectors) | ✅ (≤ 4, beta) | ✅ CIMD / DCR | Code tab ✅; Chat tab ? | ? | ? | ✅ / ✅ | ? |
| claude.ai web | hosted | ❌ | ✅ (public IPv4 only) | ✅ (beta) | ✅ CIMD / DCR / own client | ? | ✅ | ? | ? / ? | ? |
| Claude mobile | hosted | ❌ | ✅ (connectors added on web) | ? | ✅ (same backend) | ? | ? | ? | ? / ? | ? |
| Cursor | ≤ 2025-11-25 | ✅ | ✅ | ✅ | ✅ DCR + static client | ✅ | ✅ | ❌ | ✅ / ✅ | **40** |
| Windsurf (now Devin Desktop) | 2026-07-28 (v3.10.67) | ✅ | ✅ | ✅ (older builds dropped headers) | ✅ (details undocumented) | ❌ not claimed | ❌ unconfirmed | ? | ✅ / ✅ | **100** across all servers |
| MCP Inspector v2 | legacy / auto / modern switch | ✅ | ✅ | ✅ | ✅ DCR + CIMD | ? (likely) | ✅ | ✅ | ✅ / ✅ | — |

Secondary clients (best effort, not in the release gate): GitHub Copilot cloud agent (tools only, static headers from
`COPILOT_MCP_*` secrets, no OAuth, no prompts/resources, **no approval step**), Visual Studio, Zed, Cline, Roo Code,
ChatGPT connectors, Gemini CLI.

## Verified so far

| Client | Version | Date | What was verified | Source |
|---|---|---|---|---|
| GitHub Copilot CLI | 1.0.87 | 2026-10-20 | **V** stdio and HTTP with a static `Authorization` header; 2026-07-28 on both; `structuredContent`; server-side schema errors shown; per-workspace tool lists; **write approval prompt shown; approve and decline work on both transports** (`input_required`) | P0-07, owner run |
| GitHub Copilot in VS Code | VS Code 1.142.0 | 2026-10-20 | **V** stdio (Remote WSL) and HTTP with a static header; **2026-07-28 on both**; per-workspace tool lists; server-side schema errors; **write approval: approve and decline work on both transports** (`input_required`); errors shown with an `MCP server '<name>':` prefix | P0-07, owner run |
| GitHub Copilot in JetBrains | plugin 1.19.2 | 2026-10-20 | **V** HTTP with a static header (IDE on Windows, server in WSL); **2025 era**; per-workspace tool lists (tools shown prefixed with the server name); server-side schema errors shown; **no approval prompt: writes refused with `AB_APPROVAL_UNAVAILABLE`**, so remote writes need the approval page; stdio not tested | P0-07, owner run |
| MCP Inspector CLI | 2.11.0 | 2026-10-20 | **V** stdio and HTTP (Node, workerd); **2025 era by default, 2026-07-28 with `--protocol-era modern`**; raw results show `structuredContent`, `isError` and annotations as sent; static `Authorization` header; no elicitation in the CLI (2025 era: `AB_APPROVAL_UNAVAILABLE`; 2026-07-28: an SDK error, see the spike's finding 7); `-e` reaches a stdio server; `--strict` flags `type` arrays as unportable | P0-07 spike |
| Claude Code | 2.1.304 | 2026-10-20 | **V** stdio and HTTP with a static `Authorization` header; 2026-07-28 on both; per-workspace tool lists; server-side schema errors shown; **write approval prompt shown; approve and decline work on both transports** (`input_required`) | P0-07, owner run (relic-bridge also saw 2.1.287 send `Mcp-Method`/`Mcp-Name` and a long-lived `subscriptions/listen`) |
| MCP Inspector CLI | 2.11.0 | 2026-10-21 | **V** the v0.1 stdio CLI (built from `main`, before publishing) against the synthetic fixture upstream (`scripts/fixture-agility.ts`): `tools/list` (13 tools) in the 2025 era, `list_my_work` and `get_work_item` in both eras with `structuredContent` and enveloped text; `-e` passes `AB_AGILITY_URL`/`AB_AGILITY_TOKEN` | P1-14 |
| MCP Inspector CLI | 2.11.0 | 2026-10-21 | **V** `agility-bridge serve` (v0.2, built from the P2-17 branch) over Streamable HTTP with a device token in a static `Authorization` header, against the synthetic fixture upstream: `initialize`, `tools/list` and a `get_assets` call (2025 era); the stray `GET` gets `405` as designed and a request without the token `401`. Both eras over HTTP ran with the SDK client in-process against the read-only tenant (`live/server.live.test.ts`). VS Code, JetBrains, Copilot CLI, Claude Code and Cursor against `serve` are the owner's runs (P2-17) | P2-17 |
| GitHub Copilot (desktop) | 2026-10 | 2026-10-02 | listed and called over HTTP | relic-bridge P0-07 (same SDK; not yet re-run against agility-bridge) |
| Claude Code | 2.1.310 | 2026-10-26 | **V** remote over HTTPS on the Cloudflare deployment (custom domain, Workers Free) with a static device token: tools listed and called | P5-06, owner run |

OAuth 2.1 (P0-08, production on Workers, 2026-10-21): **Claude Code 2.1.304** and **VS Code 1.142.0** sign in through
**CIMD** (`https://claude.ai/oauth/claude-code-client-metadata`, `https://vscode.dev/oauth/client-metadata.json`), **MCP
Inspector CLI 2.11.0** through **DCR** (it needs a TTY for interactive OAuth); all three send `resource` and request
`offline_access`, and their tokens are bound to one workspace (**V**).

Measured server-side (P0-07): elicitation can approve a write on **stdio** (either era) and on **2026-07-28 HTTP**, never
on 2025-era HTTP. The rest of the matrix is the owner's checklist in
[`spikes/mcp-sdk-v2/client-checklist.md`](../../spikes/mcp-sdk-v2/client-checklist.md).

## OAuth runs (P5-06)

Against the Cloudflare deployment (Worker on a custom domain, Workers Free, sign-in through Cloudflare Access,
`AB_OAUTH=on`). Evidence: the owner's runs and the audit log (client id, grant type), never tenant content.

| Client | Version | Date | Discovery | Registration | Sign-in and consent | Tools | Refresh | Disconnect / reconnect |
|---|---|---|---|---|---|---|---|---|
| claude.ai web | hosted | 2026-10-26 | **V** from the MCP route's `WWW-Authenticate` | **V** client metadata document (`https://claude.ai/oauth/mcp-oauth-client-metadata`) | **V** | **V** | not run | not run |
| Claude Code | 2.1.310 | 2026-10-26 | **V** | **V** client metadata document (`https://claude.ai/oauth/claude-code-client-metadata`) | **V** | **V** | **V** silent `refresh_token` exchange | not run |
| Claude mobile, Claude Desktop connectors, VS Code, JetBrains, Copilot CLI, MCP Inspector | — | — | not run yet | | | | | |
| Cursor, Windsurf / Devin Desktop | — | — | not run (no subscription available) | | | | | |

The rows marked "not run" are [P6-14](../tasks/phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md). No client has
used dynamic registration against this release (D-68; MCP Inspector did in the Phase 0 spike, above), and none has needed a
private-use redirect (D-69). Only what the runs above observed is marked **V**: the guides say "documented only" for the rest.

## v0.1 client snippets (P1-14)

The snippets in the [client setup guide](../guide/clients.md) for VS Code, Claude Code, Copilot CLI and JetBrains are
verified by the owner against v0.1 (version and date recorded above when done); Cursor, Windsurf and Claude Desktop are
documented only. To try a client without a real instance, run `node scripts/fixture-agility.ts` and point
`AB_AGILITY_URL` at the URL it prints.

## Remote snippets (P4-06)

The admin panel's Connect page and the [client setup guide](../guide/clients.md#remote-server-device-token) show these forms
for `https://<host>/w/<workspace>/mcp` with a device token (a test keeps the guide equal to the generated text). Formats were
read in each vendor's documentation on 2026-10-23; **none is verified against a real client by P4-06**, that stays with the
owner's matrix runs (VS Code, JetBrains, Copilot CLI, Claude Code and MCP Inspector were run with a static header in P0-07 and
P2-17, see above; Cursor and Windsurf are documentation only).

| Client | Remote form | Token handling | Status |
|---|---|---|---|
| VS Code | `.vscode/mcp.json`: `inputs` (`promptString`, `password: true`) and `servers.<name>`: `type: http`, `url`, `headers` with `${input:id}` | prompt, secret storage | docs + **V** static header (P0-07) |
| JetBrains | `mcp.json`: `servers.<name>.url` and `requestInit.headers` | literal in the file (no prompt, no expansion) | docs + **V** (P0-07) |
| Copilot CLI | `copilot mcp add --transport http --header "Authorization: Bearer $VAR" <name> <url>` (writes `~/.copilot/mcp-config.json`) | shell variable at add time, stored in plain text | docs + **V** static header (1.0.87) |
| Claude Code | `claude mcp add --transport http --scope user <name> <url> --header "…"`; `.mcp.json` with `type: http` and `${VAR}` in `headers` | shell variable, or `${VAR}` expanded at start | docs + **V** static header (2.1.304) |
| Cursor | `mcp.json`: `mcpServers.<name>`: `url`, `headers` with `${env:VAR}` | environment variable | docs only |
| Windsurf / Devin Desktop | `~/.config/devin/mcp_config.json`: `mcpServers.<name>`: `serverUrl`, `headers` with `${env:VAR}` | environment variable (unset becomes empty) | docs only |
| MCP Inspector CLI | `npx @modelcontextprotocol/inspector --cli <url> --transport http --header "…" --method tools/list` | shell variable | **V** 2.11.0 (P2-17, spike) |

claude.ai, Claude Desktop connectors and Claude mobile need OAuth (P5-06) and have no snippet; the Claude Desktop `mcp-remote`
bridge (a third-party package) is deliberately not offered (D-41).

## How agility-bridge features map to each client

| Client | Local (stdio) | Remote | Write approval channel (Phase 7) |
|---|---|---|---|
| VS Code | ✅ | device token in a password `input`, or OAuth (Phase 5) | elicitation on stdio and HTTP (**V** 2026-10-20, 2026-07-28); approval page only if a release falls back to the 2025 era |
| JetBrains | ✅ | device token (stored in plain text by the IDE: use short expiry) or OAuth preview | stdio: elicitation (not verified) · remote: approval page (**V**: 2025-era HTTP, writes refused with `AB_APPROVAL_UNAVAILABLE`) |
| Copilot CLI | ✅ | device token or OAuth | elicitation on stdio and HTTP (**V** 1.0.87) |
| Claude Code | ✅ | device token or OAuth | elicitation on stdio and HTTP (**V** 2.1.304) |
| Claude Desktop | ✅ (config file or extension) | OAuth connector | Code tab: elicitation · Chat tab: approval page until elicitation is verified |
| claude.ai web / mobile | — | OAuth connector (public HTTPS) | approval page (open the link on the phone, sign in) |
| Cursor | ✅ | device token (via `${env:…}`) or OAuth | stdio: elicitation · remote: approval page |
| Windsurf / Devin Desktop | ✅ | device token | approval page (remote); stdio writes refused unless the operator relaxes approval |
| Copilot cloud agent | — | device token in `COPILOT_MCP_*` secret | **none**: writes refused (no elicitation, no browser) |
| MCP Inspector | ✅ | both | CLI: none (**V** 2.11.0, writes refused); web UI: to verify |

Consequences for the design:

- **Both protocol eras are mandatory** (Copilot in JetBrains and MCP Inspector CLI speak 2025-era revisions, verified; Cursor documented) — [ADR-0005](../adr/0005-mcp-sdk-v2-stateless.md).
- **Keep the default catalogue well under 40 tools** (Cursor) and remember Windsurf's 100-tool budget is shared with
  other servers — L-155, P0-11.
- **Do not rely on annotations** for safety: only VS Code uses `readOnlyHint` (to skip confirmation) — L-154.
- **Write approval needs an out-of-band page** for 2025-era clients over HTTP (JetBrains verified, Cursor documented) and for mobile — L-156, P7-02.
- **Hosted Claude connectors** need a public, IPv4-reachable HTTPS URL; private or on-premises-only deployments serve
  IDE and CLI clients only (or need a tunnel).

## Setup notes per client

Snippets are illustrative and use placeholders; P1-14 verifies each one against the client's current documentation and
publishes the guides. Never paste a real token into a file that is committed or synced.

### GitHub Copilot in VS Code

`.vscode/mcp.json` (workspace) or the user-profile `mcp.json` (**MCP: Open User Configuration**). Secrets come from
`inputs` with `password: true`, which VS Code prompts for and stores securely.

```json
{
  "inputs": [
    { "id": "agility-token", "type": "promptString", "description": "Agility access token", "password": true }
  ],
  "servers": {
    "agility": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agility-bridge"],
      "env": {
        "AB_AGILITY_URL": "https://www7.v1host.com/YourInstance",
        "AB_AGILITY_TOKEN": "${input:agility-token}"
      }
    }
  }
}
```

Remote: `"type": "http"`, `"url": "https://agility-bridge.example.com/w/my-team/mcp"`, `"headers": { "Authorization":
"Bearer ${input:ab-device-token}" }`, or no header once OAuth is enabled. Quirk: servers that need `${input:…}` in
`.vscode/mcp.json` are not forwarded to Copilot agent sessions started outside the editor; use the user configuration
there.

### GitHub Copilot in JetBrains IDEs

Configured globally from the Copilot settings (shared by all JetBrains IDEs). Remote headers must be nested under
`requestInit.headers`; there is no secret prompt, so values are stored in plain text — prefer short-lived device tokens
or OAuth.

```json
{
  "servers": {
    "agility": {
      "url": "https://agility-bridge.example.com/w/my-team/mcp",
      "requestInit": { "headers": { "Authorization": "Bearer ab_<your device token>" } }
    }
  }
}
```

### GitHub Copilot CLI

`copilot mcp add` or `~/.copilot/mcp-config.json` (`mcpServers`; `env` and `headers` support `$VAR` / `${VAR}`
substitution *(unverified: the vendor page shows literal header values only)*; a `tools` allowlist is required). Remote
servers are low-trust by default: every call asks for permission. The remote snippet uses `copilot mcp add --transport http
--header` (documented), which writes the header into that file.

### Claude Code

```sh
claude mcp add agility --scope user \
  --env AB_AGILITY_URL=https://www7.v1host.com/YourInstance \
  --env AB_AGILITY_TOKEN="$AB_AGILITY_TOKEN" \
  -- npx -y agility-bridge
```

Remote: `claude mcp add --transport http agility https://agility-bridge.example.com/w/my-team/mcp --header
"Authorization: Bearer $AGILITY_BRIDGE_TOKEN"` (the shell expands the variable; read it with `read -rs` so it stays out of the
history), or OAuth without a header. Quirk: credential-looking variables referenced from a
project `.mcp.json` resolve to empty for remote servers; keep tokens in user scope.

### Claude Desktop, claude.ai and Claude mobile

- Local: `claude_desktop_config.json` (`mcpServers`, stdio only, restart to reload; the app does not inherit the shell
  environment) or a Desktop Extension.
- Remote: **Settings → Connectors → Add custom connector** with the workspace URL; OAuth from Phase 5. Connectors are
  added on the web or desktop and then available on mobile. The URL must be public HTTPS on IPv4.

### Cursor

`~/.cursor/mcp.json` or `.cursor/mcp.json` (`mcpServers`). Use `${env:NAME}` interpolation instead of literal secrets
(there is no prompt mechanism and the file is plain text). Watch the 40-tool cap.

### Windsurf (Devin Desktop)

`~/.config/devin/mcp_config.json` (formerly `~/.codeium/windsurf/mcp_config.json`), `mcpServers`; restart after
changes. Older builds dropped custom headers; P1-14 records the working form.

### MCP Inspector

`npx @modelcontextprotocol/inspector` (web, `--cli` or `--tui`), with `--transport stdio|http`, `--header`, and
`--protocol-era legacy|auto|modern` to test both eras. Headers are stored in plain text in its configuration.

## Verification checklist (per client and release)

- [ ] Starts locally with `npx` on macOS, Windows (PowerShell quoting) and Linux; tools appear.
- [ ] `tools/list` count and size for the default catalogue and with every optional group enabled.
- [ ] A read call, a paged call (`cursor`), an error (`AB_NOT_FOUND`), an untrusted-content probe.
- [ ] Prompts and resources listed and readable.
- [ ] Remote with a device token; refusal on another workspace URL; revocation takes effect.
- [ ] OAuth (Phase 5): discovery, consent, refresh under parallel calls, disconnect, reconnect.
- [ ] Writes (Phase 7): dry run, approval through the client's channel, refusal, idempotent repeat.
- [ ] MCP Apps rendering and fallback (Phase 8); Tasks (Phase 8).
- [ ] After an upgrade: reconnect refreshes the tool list.

## Sources

VS Code: [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers), release notes
[1.101](https://code.visualstudio.com/updates/v1_101), [1.103](https://code.visualstudio.com/updates/v1_103),
[MCP Apps support](https://code.visualstudio.com/blogs/2026/01/26/mcp-apps-support) · JetBrains and Copilot CLI:
[GitHub changelog](https://github.blog/changelog/), [copilot-cli](https://github.com/github/copilot-cli) · Copilot
cloud agent: [configure MCP servers](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/extend-coding-agent-with-mcp) ·
Claude: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [connector authentication](https://claude.com/docs/connectors/building/authentication) ·
Cursor: [MCP](https://cursor.com/docs/context/mcp) · Windsurf/Devin: [Devin Desktop MCP](https://docs.devin.ai/) ·
Inspector: [repository](https://github.com/modelcontextprotocol/inspector). Collected 2026-10-16; P1-14 re-checks every
link.
