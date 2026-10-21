# Prior-art review

> Status: P0-10, checked 2026-10-20. Covers seven candidates; Agility itself has no maintained MCP server.

Method: reads of official READMEs, docs, release notes and the GitHub API (stars, `pushed_at`, license). No repository
was cloned, no code was copied. Anything not seen on a page is marked *unverified*. Star counts and dates are
point-in-time (2026-10-20).

## Matrix

| Candidate | Runtime / transports | Auth | Multi-instance | Tools / naming | Query safety | Write gating | Paging / shaping | License / activity |
|---|---|---|---|---|---|---|---|---|
| GitHub MCP server | Go; stdio (Docker/binary) + hosted HTTP | PAT, OAuth (local and remote), `Authorization: Bearer` on remote | Yes: `--gh-host` for GHES / ghe.com, HTTPS required | Count *unverified*; `snake_case` (`issue_read`, `get_file_contents`); 22 toolsets, default 5; old names kept as aliases | Search takes GitHub query strings (caller-built); *unverified* beyond that | `--read-only` (wins over `--tools`); toolsets; lockdown mode (best-effort prompt-injection filter) | `page`/`perPage` (max 100), some cursors; `fields` trimming; structured output only for MCP 2026-07-28+ | MIT; 33.8k stars; v2.0.2 on 2026-10-08; pushed 2026-10-19 |
| Atlassian Rovo MCP | Remote HTTP `mcp.atlassian.com/v2/mcp`; `mcp-remote` proxy for local clients; legacy SSE ended 2026-06-30 | OAuth 2.1; API token (Basic) or service-account key (Bearer), admin-enabled | One site per consent (*unverified* for several sites) | Jira: 52 tools, 6 always listed, 46 deferred via `discover` + `executeRead/Write/Destructive`; camelCase (`getJiraIssue`) | Free-form JQL string (`searchJiraIssuesUsingJql`); validation *unverified* | Permission groups per product (`read_`, `write_`, `search_`, `delete_`, `manage_`); delete and manage off by default; admin controls | Details *unverified*; `?tools=all` gives a flat paged tool list | Apache-2.0 (docs repo); 1.1k stars; pushed 2026-10-10; GA |
| Azure DevOps MCP (Microsoft) | Node 20+, stdio (`npx @azure-devops/mcp`); remote HTTP `mcp.dev.azure.com/{org}`, recommended | Interactive Microsoft sign-in, `azcli`; PAT not mentioned on the page | One organization per server entry; remote URL carries the org | 44 tools / 97 operations (TOOLSET.md); `<domain>_<resource>`, writes get `_write` suffix; action argument selects the operation; 9 domains via `-d` | Ad-hoc WIQL string via `wit_query` action `wiql`; no bound parameters seen | Read/write split by tool (`*_write`) so hosts can allow-list; no read-only flag on the page (*unverified*) | *Unverified* | MIT; 2.1k stars; pushed 2026-10-19; no GitHub releases listed |
| Linear (official remote) | Remote Streamable HTTP `mcp.linear.app/mcp`; SSE deprecated | OAuth 2.1 with dynamic client registration; `Authorization: Bearer` with OAuth token or API key | One workspace per OAuth session | Not documented officially (find / create / update for issues, projects, comments); names *unverified* | GraphQL behind typed tools; no raw passthrough documented | `/mcp/readonly` endpoint, `read` OAuth scope, read-only API key | *Unverified* | Closed source (hosted service); docs only |
| Agility prototype (Quantiser/mcp-server) | Python 3.10+, FastMCP; stdio presumed | VersionOne access token env var, base URL env var | No (one env) | 4 read tools: `get_stories`, `get_story_details`, `get_features`, `get_feature_details` | Raw `where` / `sel` / `sort` strings passed to the API | Read-only by omission | `page_size` (20), `page_start` | No license; 0 stars; one commit 2025-07-30; dormant |
| Other Agility / VersionOne MCP | None found | n/a | n/a | n/a | n/a | n/a | n/a | GitHub repo search (`versionone mcp`, `agility mcp digital.ai`) returned 0; web search found only Agility CMS and unrelated servers |
| Agility SDKs | Java (`V1Connector`), JavaScript (Node), Python (`v1pysdk`), .NET; all call `rest-1.v1` (JS says so; `query.v1` not mentioned) | Username/password, access token (Java, JS), implicit/NTLM; Python shows only user/password | One connection object per instance | n/a (libraries) | JS: query objects (`where: {Status: ...}`); Python: `where(Attr="v")` plus `filter("...")` free strings; Java: *unverified* | n/a | Python / Java / JS paging *unverified* | JS BSD-3, pushed 2026-09-07; Java "modified BSD", pushed 2026-08-01; Python BSD-3, pushed 2022-02-12; .NET pushed 2023-04-14 |
| Digital.ai Release MCP | Docker image `xebialabs/dai-release-mcp`; `MCP_TRANSPORT` defaults to stdio, HTTP host/port variables exist | `RELEASE_AUTH_TYPE` = basic or token (bearer in a dev build) | One `RELEASE_BASE_URL` per process | Tool groups only (release, template, task, variable, monitoring, type discovery, attachments); names *unverified*; "may change without notice" | *Unverified* | `MCP_READONLY_MODE` (default off) disables writes | *Unverified* | License not stated; tag 26.1.2, updated about two months ago; custom use "not officially supported" |

## Per candidate

### GitHub MCP server
- Local stdio and hosted HTTP from one codebase; the operator can cap what clients request (`X-MCP-Lockdown` can only raise lockdown, never lower an operator setting).
- Toolsets are the main size control (default set of 5 of 22), plus `--tools` for single tools and `--read-only` that overrides explicit tool requests.
- Lockdown mode filters content from authors without push access in public repos. The README itself says it is "not an authorization boundary".
- Renames keep aliases; structured output is gated by protocol version, older clients get text.
- Sources: [repo](https://github.com/github/github-mcp-server), [releases API](https://api.github.com/repos/github/github-mcp-server/releases/latest).

### Atlassian Rovo MCP
- Jira has 52 tools. Only 6 are listed; the other 46 are found with `discover` and run through three executor tools by risk tier (read, write, destructive). This is a direct answer to tool-count pressure.
- Admins grant permission groups; `delete_jira` and `manage_jira` are off by default. OAuth scopes are `read:/write:/search:jira:agent-interface`.
- API tokens suit headless use but need an admin to enable them.
- JQL is a string the model writes. The docs give no validation detail (*unverified*).
- Sources: [supported tools](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/), [atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server).

### Azure DevOps MCP
- 44 tools in 9 domains; one tool per resource with an `action` argument (`wit_work_item`: get, get_batch, list_comments, my, ...). Fewer tools, bigger schemas.
- Reads and writes are separate tools (`wit_work_item` vs `wit_work_item_write`), which lets a host allow-list reads without a server flag.
- WIQL is an `wiql` action on `wit_query`: an ad-hoc string.
- Remote server is the recommended path; the local one is the older option.
- Sources: [repo](https://github.com/microsoft/azure-devops-mcp), [TOOLSET.md](https://raw.githubusercontent.com/microsoft/azure-devops-mcp/main/docs/TOOLSET.md). Community Azure DevOps servers were not reviewed (*unverified*).

### Linear
- Smallest operational surface: one endpoint, OAuth with dynamic client registration, or a bearer key for headless use.
- Read-only is a separate URL and a scope, so a client can be given a connection that cannot write.
- One workspace per OAuth session; several workspaces need several auth contexts.
- Tool names and shapes are not documented on the docs page (*unverified*).
- Source: [Linear MCP docs](https://linear.app/docs/mcp).

### Agility prototype and other Agility MCP
- Quantiser/mcp-server is the only artifact. It passes `where`, `sel` and `sort` strings to the REST API, which is the pattern ADR-0012 rejects.
- No other Agility / VersionOne MCP found on GitHub or the web (searches 2026-10-20; the registries listed in RESEARCH §7 were checked earlier, not re-run).
- Sources: [repo](https://github.com/Quantiser/mcp-server), [API](https://api.github.com/repos/Quantiser/mcp-server).

### Agility SDKs
- JS SDK is the active one (2026-09), with access-token support and object-style `where`. Python SDK has been idle since 2022 and shows only username/password on its page. Java and .NET: see matrix.
- Python offers both a safe-looking `where(Attr="v")` and a free `filter("...")` string; the SDKs do not escape for you. None of the pages mention `query.v1` or `with` variables, so the bound-parameter approach has no SDK precedent (*unverified* in source).
- Sources: [org repos](https://api.github.com/orgs/versionone/repos?per_page=100&sort=pushed), [JS](https://github.com/versionone/VersionOne.SDK.JavaScript), [Python](https://github.com/VersionOne/VersionOne.SDK.Python), [Java](https://github.com/versionone/VersionOne.SDK.Java.APIClient).

### Digital.ai Release MCP
- Exists for Release, not Agility. Docker image, stdio default, `MCP_READONLY_MODE` env switch, basic or token auth. Docs warn tools may change and custom use is unsupported.
- No sign of an Agility counterpart or announcement (web search 2026-10-20).
- Sources: [docs](https://docs.digital.ai/release/docs/next/how-to/release-mcp-server), [Docker Hub](https://hub.docker.com/r/xebialabs/dai-release-mcp).

## Adopt

- **Group-based tool exposure with a hard read-only override** (GitHub toolsets and `--read-only` beating `--tools`; Atlassian permission groups). Fits the catalogue groups and ADR-0013's "all tools never includes writes".
- **Operator caps that clients cannot loosen** (GitHub's lockdown header). Same shape as workspace limits and the write switch in ADR-0013 and ADR-0008.
- **Read-only as a separate connection** (Linear's `/mcp/readonly` and `read` scope). Maps to the `mcp:write` scope in ADR-0013; consider a read-only workspace URL variant.
- **Writes as separate tools from reads** (Azure DevOps `_write`, Atlassian write/destructive tiers). Matches the `kind` annotation plan and the separate `writes` group.
- **Tier destructive operations separately and off by default** (Atlassian delete/manage). Supports `close_asset` / `reopen_asset` as `destructive`.
- **Aliases for renamed tools** (GitHub). Useful for the Deprecations section of the tool conventions.
- **Version-gated structured output** (GitHub). Same as ADR-0015 handling of 2025-era vs 2026-07-28 clients.
- **`fields` trimming on list tools** (GitHub) and explicit page size caps. Already in `query_assets` and `minimal_output`.
- **Token-based headless auth with admin opt-in** (Atlassian). Compatible with the personal-credential model in ADR-0008.

## Avoid

- **Free-form query strings from the model** (Atlassian JQL, Azure DevOps WIQL, Quantiser `where`, Python `filter("...")`). Keep ADR-0012 / L-057; no `where` string in any tool.
- **Raw API passthrough or generic filters on write paths.** None of the candidates solved this; do not copy.
- **Hundreds of tools or large always-on catalogues** (Atlassian needed deferral to hide 46 of 52). Keep the L-155 cap (<= 40, default 20).
- **Relying on a content filter as a security boundary** (GitHub states lockdown is not one). Keep scope enforcement and the untrusted-data envelope as separate mechanisms (L-038).
- **Action-argument mega-tools** (Azure DevOps `wit_work_item` with seven actions). They hide read/write differences from MCP annotations; keep one tool per operation.
- **Undocumented or unstable tool names** (Linear, Release MCP "may change without notice"). Freeze names per tool as the catalogue plans.
- **Username/password auth** shown by the Python SDK. Access tokens only, as in ADR-0008.

## Differentiate

- **Bound parameters end to end**: `query.v1` with `with` variables, validated attribute paths and operator allowlist (ADR-0012). No candidate does this.
- **Server-added scope restriction** at the top of every query (THREAT_MODEL T3); the candidates rely on the caller's own permissions.
- **Human approval bound to a hash of the exact change**, with elicitation and an out-of-band page (ADR-0013). Others offer only on/off switches or client-side confirmation (Atlassian advises reviewing high-impact changes, no mechanism documented).
- **Several Agility instances and workspaces per deployment** with instance URLs fixed by admins (ADR-0008); Linear needs one auth context per workspace, Azure DevOps one entry per org.
- **Any asset type through metadata-driven generic tools**, plus typed workflow tools and reports, in a catalogue small enough for Cursor's cap (L-155).
- **Untrusted-data envelope on every output path** (ADR-0015, L-038); GitHub's lockdown filters by author only on public repos.

## Proposed follow-ups

Inputs for P0-11 (tool contract and conventions), which decides each one and records the outcome in the task or doc it
names:

- Add a **deferred-tool or tool-search fallback** as a design note for when the catalogue exceeds a client's cap: affects `docs/reference/tool-catalogue.md` and P1-13 (evidence: Atlassian 6 + 46).
- Add **tool aliases on rename** to the Deprecations section of `docs/dev/tool-conventions.md` (evidence: GitHub).
- Specify a **read-only workspace URL or scope variant** (Linear `/mcp/readonly`) as an option in the workspace model: affects ADR-0008 details (P2-04) and ADR-0013's `mcp:write` scope.
- Add an **operator-cap rule** to conventions or ARCHITECTURE: request headers may narrow limits, never widen (evidence: GitHub `X-MCP-Lockdown`). Affects P2-04 / http-app.
- Add **access-token-only** and "no `where` string" checks to the secret-field and naming lints: affects P1-13 lints.
- Add a **negative fixture** to the ADR-0012 tests using the Quantiser-style `where` strings and WIQL / JQL-like inputs (all must be rejected): affects P1-08.
- Record in RESEARCH §1 that **SDK pages do not mention `query.v1`** and the Python SDK is idle since 2022; keep open question 2 (`with` binding behaviour) as the only evidence source: affects P0 spike for `with`.

### Decisions (P0-11, 2026-10-21)

| # | Follow-up | Decision |
|---|---|---|
| 1 | Deferred-tool or tool-search fallback | **Not now.** The catalogue stays at 20 tools by default and 35 at most, with a `tools/list` size budget (tool conventions); revisit if it approaches 40. |
| 2 | Tool aliases on rename | **Adopted** in the Deprecations section (aliases for one minor release and six months from 1.0). |
| 3 | Read-only connection variant | **Not needed:** writes already need the grant's write flag, the workspace switch and, with OAuth, the `mcp:write` scope (ADR-0013); a read-only device token or OAuth consent without `mcp:write` is the read-only connection. |
| 4 | Operator caps that clients cannot loosen | **Adopted** as "Client hints and operator limits" in the tool conventions. |
| 5 | Lint additions | **Adopted:** raw-filter argument names (`where`, `query`, `oql`, `raw`, …) refused by the naming lint; secrets refused by the secret-field lint. Access tokens are already the only Agility credential (D-18). |
| 6 | Negative query fixtures | **Adopted** in the tool conventions' Lints section, with the P0-06 `with` cases (P1-04, P1-08). |
| 7 | RESEARCH note on the SDKs | **Done** in P0-10; the `with` question was answered by P0-06 (L-162). |

## Sources

All accessed 2026-10-20.

- https://github.com/github/github-mcp-server
- https://api.github.com/repos/github/github-mcp-server
- https://api.github.com/repos/github/github-mcp-server/releases/latest
- https://github.com/atlassian/atlassian-mcp-server
- https://api.github.com/repos/atlassian/atlassian-mcp-server
- https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/
- https://github.com/microsoft/azure-devops-mcp
- https://raw.githubusercontent.com/microsoft/azure-devops-mcp/main/docs/TOOLSET.md
- https://api.github.com/repos/microsoft/azure-devops-mcp
- https://linear.app/docs/mcp
- https://github.com/Quantiser/mcp-server
- https://api.github.com/repos/Quantiser/mcp-server
- https://api.github.com/orgs/versionone/repos?per_page=100&sort=pushed
- https://github.com/versionone/VersionOne.SDK.JavaScript
- https://github.com/VersionOne/VersionOne.SDK.Python
- https://github.com/versionone/VersionOne.SDK.Java.APIClient
- https://docs.digital.ai/release/docs/next/how-to/release-mcp-server
- https://hub.docker.com/r/xebialabs/dai-release-mcp
- GitHub repository searches `versionone mcp`, `agility mcp digital.ai` (0 results); web searches for Agility / VersionOne MCP (no hits)
