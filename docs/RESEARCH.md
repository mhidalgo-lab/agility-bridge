# Research and platform facts

> Status: **initial research** (2026-10-16). Facts here come from vendor documentation and specifications and are
> **not yet verified against a live Agility instance or real clients**. The Phase 0 spikes (P0-06 – P0-09) confirm or
> correct each one and record the result here with a date. Mark every new fact with its source URL and how it was
> verified: `docs` (read in documentation), `live` (observed against a real system, with date and version) or
> `unverified` (secondary source or inference).

Contents:

1. [Digital.ai Agility](#1-digitalai-agility)
2. [MCP protocol and TypeScript SDK](#2-mcp-protocol-and-typescript-sdk)
3. [MCP clients](#3-mcp-clients)
4. [OAuth 2.1 for MCP](#4-oauth-21-for-mcp)
5. [Cloudflare Workers platform](#5-cloudflare-workers-platform)
6. [Node.js, Docker, SQLite, npm and registries](#6-nodejs-docker-sqlite-npm-and-registries)
7. [Prior art](#7-prior-art)
8. [Open questions for the Phase 0 spikes](#8-open-questions-for-the-phase-0-spikes)

Abbreviation: **DL** = `https://docs.digital.ai/agility/docs/developerlibrary/` (Agility developer library).

---

## 1. Digital.ai Agility

### 1.1 Product, versions and terminology

- Digital.ai Agility is the enterprise agile planning product formerly known as **VersionOne** (VersionOne → CollabNet
  VersionOne → Digital.ai). The API surface (`rest-1.v1`, `meta.v1`, attachments) has been stable since 2007 with no
  deprecation notices across the rebrands. *docs*
- Latest release at the time of writing: **26.2** (July 2026; public example instances report build `26.2.6.29`);
  **26.3** is planned for late October 2026. Releases are quarterly (`xx.0` … `xx.3`) with bi-weekly point releases.
  The 26.0 – 26.2 release notes show no API deprecations. *docs, unverified for point releases*
- UI vocabulary depends on the methodology template; the API names are fixed. *docs* —
  [DL assets](https://docs.digital.ai/agility/docs/developerlibrary/assets)

| API name | Scrum UI | Other UIs |
|---|---|---|
| `Story` | Backlog Item | Story (XP), Requirement (AgileUP/DSDM) |
| `Scope` | Project (also "Planning Level" in portfolio docs) | Project |
| `ScopeLabel` | Program | Program |
| `Timebox` | Sprint | Iteration |
| `Epic` | Portfolio Item (categories such as Epic, Feature, Initiative are values of a type field, not asset types) | — |
| `TeamRoom` | Team Room | — |

### 1.2 API inventory

| Family | URL pattern | Methods / format | Purpose | Source |
|---|---|---|---|---|
| `rest-1.v1/Data` | `/rest-1.v1/Data/<AssetType>[/<id>]` | GET/POST, XML (JSON on request: *unverified*) | Read; create/update one asset; operations via `?op=` | [DL rest-1-v1-endpoints](https://docs.digital.ai/agility/docs/developerlibrary/rest-1-v1-endpoints) |
| `rest-1.v1/Hist` | `/rest-1.v1/Hist/<AssetType>` | GET, XML | History: one row per version (moment) of an asset | [DL history queries](https://docs.digital.ai/agility/docs/developerlibrary/learn-by-example-history-queries) |
| `rest-1.v1/New` | `/rest-1.v1/New/<AssetType>?ctx=<OID>` | GET, XML | Template for a new asset (defaults, context copy) | DL rest-1-v1-endpoints |
| `query.v1` | `/query.v1` | POST (GET), JSON or YAML in, JSON out | Read-only, nested selections, several queries per call | [DL tour of query.v1](https://docs.digital.ai/agility/docs/developerlibrary/tour-query-v-1) |
| `query.legacy.v1` | `/query.legacy.v1` | as above | Same, accepting Basic auth or the browser session cookie | DL tour of query.v1 |
| `meta.v1` | `/meta.v1[/<AssetType>[/<Attribute or Operation>]]` | GET, XML or **JSON** (`Accept: application/json`, *live* 2026-10-20), **no authentication** | Schema: asset types, attributes, types, inheritance, operations, validators | [DL meta API](https://docs.digital.ai/agility/docs/developerlibrary/meta-api) |
| `api/asset` (Bulk API) | `/api/asset[?previewOnly=true]` | POST, JSON (object or array) | Create, update, add/remove relations, execute operations; deferred execution with `previewOnly` | [Bulk API](https://docs.digital.ai/agility/docs/agility-bulk-api), [quickstart](https://docs.digital.ai/agility/docs/bulk-api-quickstart), [advanced topics](https://docs.digital.ai/agility/docs/advanced-bulk-topics) |
| `api/ActivityStream` | `/api/ActivityStream/<OID>` | GET, JSON | Activity feed; "may not contain every change" | [DL activity stream](https://docs.digital.ai/agility/docs/developerlibrary/activity-stream) |
| `attachments.img` | `/attachments.img/<id>` | GET / POST multipart | Attachment content (two steps: create the `Attachment` asset, then upload) | [DL attachments](https://docs.digital.ai/agility/docs/developerlibrary/working-with-attachments-and-images) |
| `api/tags` | `/api/tags/...` | GET/POST, JSON only | Tag management (assignment via the `TaggedWith` relation) | [DL tags](https://docs.digital.ai/agility/docs/developerlibrary/api-tags) |
| `assetdetail.v1` | `/assetdetail.v1?oid=<OID>` or `?number=<Number>` | GET → redirect | Permalink to an asset in the UI | [DL utility endpoints](https://docs.digital.ai/agility/docs/developerlibrary/utility-endpoints) |
| `API/ProjectRoles` | `/API/ProjectRoles` | GET, JSON | Member ↔ project ↔ role queries | DL utility endpoints |
| `loc.v1`, `loc-2.v1` | `/loc.v1?<key>`, `/loc-2.v1?[k1,k2]` | GET | Localised labels | [DL localization](https://docs.digital.ai/agility/docs/developerlibrary/localization-endpoints) |
| Webhooks | UI-configured outbound webhooks; a 2018-era `api/webhook` subscription API | JSON | Change notifications | [webhooks](https://docs.digital.ai/agility/docs/agility/webhook) (subscription API: *unverified current*) |
| Data Mart | SQL star schema (not HTTP) | SQL | Reporting warehouse | [DL data mart](https://docs.digital.ai/agility/docs/developerlibrary/data-mart) |

There is no `config.v1` endpoint. *docs*

### 1.3 Authentication and visibility

- **Access tokens** (recommended): created in the UI from the member's **Applications** page by adding a grant of type
  *Access Token* to a personal or public application. Applications can be created through the API; **grants cannot**.
  Sent as `Authorization: Bearer <token>`. They **never expire** and are revoked by the member or an administrator.
  The grant "allows an application to operate on the member's behalf with the same Roles and Project Memberships that
  are assigned to that member" — **there are no scopes**. They work whatever the instance's login method (Basic, NTLM,
  SAML SSO). *docs* — [DL access tokens](https://docs.digital.ai/agility/docs/developerlibrary/access-token-authentication)
- **OAuth2 grants**: a different grant type on the same page, with expiring tokens and refresh. *docs* —
  [authorizing external application access](https://docs.digital.ai/agility/docs/agility/authorizing-external-application-access)
- **Basic authentication** (username/password) is supported and documented as less secure; **Windows Integrated
  Authentication (NTLM)** exists for on-premises installations. *docs* —
  [DL Windows authentication](https://docs.digital.ai/agility/docs/developerlibrary/windows-integrated-authentication)
- The API authentication table lists, per endpoint: `query.v1` — all methods except NTLM; `meta.v1` and `loc.v1` — none
  (no authentication); `attachment.img`, `rest-1.v1/Hist`, `rest-1.v1/New` — all. Access tokens therefore work with
  `query.v1`; P0-06 still checks older on-premises versions. (The query.v1 tour's remark about OAuth2 scope
  `query-api-1.0` concerns the interactive API console; `query.legacy.v1` accepts Basic auth or the session cookie.)
  *docs* — [DL API authentication](https://docs.digital.ai/agility/docs/developerlibrary/api-authentication)
- **Visibility**: every read and write is filtered to what the token's member can see (roles and project memberships).
  A 404 is returned both for missing assets and for assets the member cannot see. *docs* —
  [DL HTTP error codes](https://docs.digital.ai/agility/docs/developerlibrary/http-error-codes)
- **Attribution**: writes are recorded under the token's member; there is no "on behalf of" header. *inferred*

### 1.4 Reading data

Parameters ([DL queries](https://docs.digital.ai/agility/docs/developerlibrary/queries)): `query.v1` supports `from`,
`select`, `page`, `sort`, `group`, `where`, `filter`, `find`, `findin`, `with`, `asof`; `rest-1.v1` supports the same
except `group`, and adds `op` (POST only). *docs*

- **rest-1.v1**: `sel` (attribute tokens), `where` (filter tokens), `sort` (`+`/`-`), `page=<size>,<start>` (size first),
  `find`/`findin` (substring search, "relatively expensive"), `asof`, `with` (`$Var=a,b|$Other=c`). `where` is ignored on
  single-asset URLs. Omitting `page` returns the whole result set. *docs / archived grammar*
- **Filter tokens**: `=`, `!=`, `<`, `<=`, `>`, `>=`, `~=` (contains); `+Attr` / `-Attr` (set / not set); `&` and `;`
  (AND), `|` (OR), parentheses; value lists (`AssetType="Task","Test"`); variables `$Name`; dot paths
  (`Category.Name`); downcasts (`Workitems:Story`); bracket filters on multi-value relations
  (`Workitems[Owners='Member:20']`); aggregations `.@Count`, `.@Sum`, `.@MinDate`, `.@MaxDate` (the archived grammar
  also lists `DistinctCount`, `Any`, `And`, `Or`, `MaxState`). Aggregations do **not** exclude deleted or template
  assets automatically. *docs / archived grammar* — [DL attributes](https://docs.digital.ai/agility/docs/developerlibrary/attributes),
  [VersionOne grammars (archived)](https://github.com/versionone/Grammars)
- **query.v1 body**: `from` (required), `select` (strings or nested `{from, select}` for relations), `where` (equality
  mapping), `filter` (list of filter-token strings, may reference `$vars`), `with` (mapping of `$var` to value, which
  "alleviates quoting issues"), `sort`, `group` (children under `_children`), `page` (`{start, size}`), `asof` (date or
  `All`), `needTotal` (otherwise `total` is `-1`). Several queries per call as a JSON array or a YAML stream. The
  response is always an **array of arrays** (one per query). *docs*
- **Dates**: ISO 8601 with `Z` and up to 7 fractional digits (e.g. `2018-08-24T15:06:53.1347214Z`); date-only values are
  accepted; `ChangeDate`/`ChangeDateUTC`-style pairs exist, and the semantic difference is not documented. *docs*
- **Binding**: `with` substitutes named constants into the same filter grammar; it is not a prepared-statement channel,
  and no escaping rule is documented for values containing `,`, `|` or quotes on the `rest-1.v1` side. *docs*

### 1.5 Writing data

- **rest-1.v1 POST** (XML): scalar `<Attribute name="X" act="set">…</Attribute>`; single relation `<Relation name="Owner"
  act="set"><Asset idref="Member:20"/></Relation>`; multi-value relation children with `act="add"` / `act="remove"`.
  *docs*
- **Operations**: `POST /rest-1.v1/Data/<Type>/<id>?op=<Name>` with an empty body; operations and their validators
  (e.g. whether an asset is deletable) are listed in `meta.v1`. Common ones: `Inactivate`, `Reactivate`, `QuickClose`,
  `Close`, `Delete`, plus an undelete endpoint. *docs* —
  [DL undelete](https://docs.digital.ai/agility/docs/developerlibrary/undelete-asset)
- **Bulk API** (`api/asset`, JSON): create `{"AssetType":"Story","Name":"…","Scope":"…"}`; update
  `{"from":"Epic:4622","update":{…}}` or **many** assets with `from` + `where`/`filter` + `update`; relation
  add/remove; `execute` an operation over a filtered set; aliases (`@name`) to reference created assets in the same
  call. `?previewOnly=true` returns the full execution plan without executing it, and the plan can be resubmitted.
  *docs* — [creation](https://docs.digital.ai/agility/docs/asset-creation-examples-1),
  [update](https://docs.digital.ai/agility/docs/asset-updation-examples),
  [operations](https://docs.digital.ai/agility/docs/asset-operation-examples), advanced topics
- **Comments, effort, links**: comments are `Conversation`/`Expression` assets, effort is `Actual`, external links are
  `Link`. Exact attributes for creating them are **unverified** (read them from `meta.v1` in P0-06).
- **Attachments**: create an `Attachment` asset, then upload the content; documented size limit 4 MB. *docs*
- **Idempotency**: no idempotency keys; each `rest-1.v1` POST is atomic for one asset. *docs / inferred*

### 1.6 Asset model

- Inheritance (from `meta.v1` `<Base>` elements): `BaseAsset` → `Workitem` → `PrimaryWorkitem` → `Story`, `Defect`,
  `TestSet`; `Epic`, `Task`, `Test`, `Theme` derive from `Workitem`; `Scope`, `Timebox`, `Team`, `Member`,
  `RegressionTest`, `RegressionPlan`, `RegressionSuite`, `Goal`, `Request`, `Issue`, `ChangeSet`, `BuildRun`, `Milestone`,
  `Retrospective`, `Schedule` derive from `BaseAsset`; `ScopeLabel` derives from `Label`; `TeamRoom` from `Room`.
  `Attachment`, `Link`, `Conversation`, `Actual`, `Expression`, `Capacity`, `Environment` stand alone. A `Note` type no
  longer exists (`Conversation` replaced it). *docs (public meta.v1 example instance), partially unverified*
- **Numbers**: work items carry a `Number` with a type prefix. Documentation examples show stories as `S-01054`; other
  instances use `B-` for stories (backlog items). Commonly seen: `E-` (Epic), `D-` (Defect), `TK-` (Task), `AT-` (Test),
  `I-` (Issue), `R-` (Request), `RP-` (RegressionPlan), `RS-` (RegressionSuite), `TS-` (TestSet). Prefixes for
  `RegressionTest`, `Goal` and `Environment` are unverified. `meta.v1` does not expose prefixes. *docs + unverified*
- **Status vs AssetState vs rollup category**: `Status` is an admin-configurable list per type; `AssetState` is the
  shared lifecycle integer: 0 Future, 64 Active, 128 Closed, 200 Template (dead), 208 Broken down (dead), 255 Deleted
  (dead), 209 Guest collaborator (members only); the rollup category (Not Started / In Progress / Completed) is for
  reporting only. *docs* — [rollup categories](https://docs.digital.ai/agility/docs/agility/rollup-category-status-values)
- **Common attributes**: `Name`, `Number`, `Description` (long text, HTML), `Status`, `Owners` (multi-relation to
  `Member`), `Team`, `Scope`, `Timebox`, `Super`/`Subs` (portfolio tree), `Estimate`, `ChangeDate`, `CreateDate`,
  `ClosedDate`-style dates with `…UTC` variants. `DetailEstimate`, `ToDo`, `Priority`, `Source`, the task/test parent
  relation and `Children` are well known from VersionOne usage but **unverified** against current metadata.
- **Custom attributes** use the `Custom_` prefix and carry `iscustom="True"` in `meta.v1`. *docs / unverified rule*

### 1.7 Limits and behaviour

- **Rate limiting** on hosted instances: per-consumer quotas by time window, response size, request count or **error
  count**. Exceeding one returns **HTTP 429** with a JSON body naming the limit and the wait:
  `{"Message": "API request quota exceeded. Maximum of 20 errors per 60 second(s)", "RetryAfter": "50"}`. A usage-metrics
  page exists for self-service. *docs* — [DL rate limiting](https://docs.digital.ai/agility/docs/developerlibrary/what-is-api-rate-limiting),
  [DL usage metrics](https://docs.digital.ai/agility/docs/developerlibrary/retrieving-api-usage-metrics)
- **HTTP errors**: 400 (bad request), 401 (unauthenticated), 404 (not found or not visible), 405 (wrong verb or
  non-updatable URL), 429, 500 (XML exception body). *docs*
- **Paging**: no documented maximum page size; omitted paging returns everything. *docs*
- **Payload limits**: only the 4 MB attachment limit is documented. **ETags/caching**: not documented. **Read-after-write
  consistency**: not documented. *docs*
- **URLs**: hosted `https://www{N}.v1host.com/{Instance}/…`; on-premises base URLs are chosen by the customer. TLS, CORS
  and IP allowlist behaviour are not documented. *docs*

### 1.8 Events

- Outbound webhooks are configured in the UI ([outbound webhook creation](https://docs.digital.ai/agility/docs/agility/outbound-webhook-creation)).
  A 2018-era subscription API (`POST api/webhook`, events `AssetCreated`/`AssetChanged`, 5 enabled subscriptions,
  disabled after 5 consecutive failures) appears only in archived documentation. *unverified current*
- Without webhooks, change detection polls `rest-1.v1/Hist` (authoritative) or the activity stream (not complete).

### 1.9 SDKs

| SDK | Repository | Last activity | Notes |
|---|---|---|---|
| Java | `versionone/VersionOne.SDK.Java.APIClient` | 2026 | Maintained; `V1Connector` builder with access token, username/password, Windows auth |
| .NET | `versionone/VersionOne.SDK.NET.APIClient` | 2022 | Stale |
| Python | `versionone/VersionOne.SDK.Python` | 2021 | Semi-stale |
| JavaScript | `versionone/VersionOne.SDK.JavaScript` (`v1sdk`) | 2020 | Stale; we will not depend on it |
| PowerShell | prototype | 2017 | Never published |

The SDKs confirm the request patterns (connector → services → query/save/execute operation) but none is a suitable
dependency for a Workers-compatible core. *docs (GitHub)*

### 1.10 Terms and trademarks

- "Digital.ai" is a trademark of Digital.ai Software, Inc.; the Terms of Use forbid using its trademarks "in connection
  with any product or service that is not ours, or in any manner that is likely to cause confusion". There is no
  dedicated trademark page. *docs* — [Terms of Use](https://digital.ai/terms-of-use/)
- The Acceptable Use Policy limits use to interfaces "provided or expressly authorized" and prohibits using service data
  to create, train or improve machine-learning systems. agility-bridge uses the documented APIs, keeps no corpus and
  trains nothing; the README says so ([ADR-0002](adr/0002-name-and-trademark.md)). *docs*

---

## 2. MCP protocol and TypeScript SDK

Checked 2026-10 in specifications and SDK documentation; P0-07 re-verifies with real clients.

- **Protocol eras.** The 2026-07-28 revision removes protocol-level sessions: no `initialize` handshake and no
  `Mcp-Session-Id`; `server/discover` replaces up-front negotiation; protocol version and client capabilities travel in
  each request's `_meta`; new `Mcp-Method` and `Mcp-Name` HTTP headers must match the body. 2025-era clients
  (2025-06-18, 2025-11-25) still use `initialize`. — [specification](https://modelcontextprotocol.io/specification/2026-07-28)
- **2026-07-28 also** replaces server-initiated elicitation, sampling and roots requests with *multi round-trip requests*
  (the server answers `input_required` and the client repeats the call with the answers), deprecates roots, sampling and
  logging (12-month grace period), makes Client ID Metadata Documents the standard client registration and requires
  RFC 9207 issuer validation. — [2026-07-28 announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- **Adoption is uneven (October 2026):** Claude Code, Copilot CLI, Windsurf/Devin Desktop and MCP Inspector speak
  2026-07-28; **VS Code (GitHub Copilot) and Cursor are capped at 2025-11-25** and reject a server that only speaks the
  new revision. Serving both eras is mandatory ([client compatibility](reference/client-compatibility.md)).
- **Batching** was removed in 2025-06-18. — [changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog)
- **Headers on the legacy path**: `Mcp-Method`/`Mcp-Name` are only trustworthy after modern-era validation; legacy
  requests can carry arbitrary values, so audit and rate limiting must read the JSON body there.
- **`subscriptions/listen`** is a long-lived POST that some clients (e.g. Claude Code) open on connect; it must not be
  counted as a tool call.
- **Tool-list changes on stateless HTTP**: there is no session to receive `notifications/tools/list_changed`; the
  2026-07-28 revision offers cache hints (`ttlMs`, `cacheScope`) but no list version or ETag. Advertise `listChanged:
  false` and tell users to reconnect after upgrades.
- **Tools**: input and output schemas are JSON Schema 2020-12; a tool with an `outputSchema` returns `structuredContent`
  together with the `content` text; annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
  are hints for clients.
- **Elicitation** lets a server ask the user a question during a request when the client declares the capability.
  Stateless 2025-era HTTP requests carry no capabilities after `initialize`, so they cannot be elicited reliably.
- **Tasks extension** (`io.modelcontextprotocol/tasks`, SEP-2663): declared by the client per request and by the server
  in `server/discover`; statuses `working`, `input_required`, `completed`, `failed`, `cancelled`; methods `tasks/get`,
  `tasks/update`, `tasks/cancel` (no `tasks/list` or `tasks/result` in 2026-07-28); task ids must be unguessable and every
  task request authorised. — [ext-tasks](https://github.com/modelcontextprotocol/ext-tasks)
- **MCP Apps** (`io.modelcontextprotocol/ui`): `ui://` resources with MIME `text/html;profile=mcp-app`, linked from a tool
  through `_meta.ui.resourceUri`, rendered by the host in a sandboxed iframe with CSP declarations; the view talks
  JSON-RPC over `postMessage`. Hosts that do not support it ignore the metadata. —
  [ext-apps](https://github.com/modelcontextprotocol/ext-apps)
- Logging and sampling moved out of the core protocol in 2026-07-28; do not depend on them.
- **TypeScript SDK v2** (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, 2.x): `serveStdio(() => build())`
  for stdio; `createMcpHandler(factory, { legacy: 'stateless' })` for HTTP, building a server per request and serving
  both eras; the handler passes `authInfo` unchanged to the factory. The legacy stateless path still executes JSON-RPC
  batches (reject them before the SDK). The default body limit is 4 MiB. Host/Origin validation is hostname-based and
  lets a missing `Origin` through. Prompts and resources are registered with `listChanged: true` unless set explicitly.
  `ProtocolError(code, message, data)` produces stable JSON-RPC errors; other thrown errors become `-32603`. The SDK has
  no server-side Tasks runtime; task storage and `tasks/*` routing are the application's job. — SDK repository
  [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Measured with SDK 2.3.1** (P0-07, 2026-10-20, *live* on Node 24 and local workerd; [results](../spikes/mcp-sdk-v2/RESULTS.md)):
  both eras pass on Node, workerd (no `nodejs_compat`) and stdio; the 2025-era HTTP path answered a two-request JSON-RPC
  batch; converting tool schemas to JSON Schema once and registering them with `fromJsonSchema` makes a per-request
  25-tool `tools/list` about 7× cheaper (0.70 ms vs 4.89 ms p50; 40 tools 0.91 ms vs 7.60 ms). Write approval: 2025-era
  push elicitation (`ctx.mcpReq.elicitInput`) works on stdio only; 2026-07-28 `inputRequired(...)` works on stdio and
  HTTP; both need the client to declare the capability.

## 3. MCP clients

Summary only; the per-client matrix, configuration formats and verification status are in
[reference/client-compatibility.md](reference/client-compatibility.md).

- **Protocol eras**: VS Code (Copilot) and Cursor negotiate up to 2025-11-25 only; Claude Code (from v2.1.292,
  2026-10-06), Copilot CLI (v1.0.81, 2026-08-27), Windsurf/Devin Desktop (v3.10.67, 2026-10-12) and MCP Inspector v2
  (explicit `protocolEra` switch) speak 2026-07-28.
- **Tool-count caps**: Cursor 40 tools; Windsurf/Devin Desktop 100 enabled tools across all servers; VS Code 128 tools per
  request (with automatic "virtual tool" grouping). A small default catalogue matters (L-155).
- **Annotations**: only VS Code uses `readOnlyHint` (to skip confirmation); no surveyed client changes its UI for
  `destructiveHint`. Safety cannot rely on annotations (L-154).
- **Elicitation**: form mode in VS Code, JetBrains, Cursor; form and URL mode in Claude Code and Copilot CLI; not in the
  Copilot cloud agent, Zed or Gemini CLI. Over stateless remote HTTP, 2025-era clients cannot be elicited (*live*, P0-07:
  even a client that declares elicitation is refused, because each request builds a server that never saw its
  capabilities), so remote write approval needs an out-of-band path for VS Code and Cursor (L-156, P7-02).
- **MCP Inspector CLI 2.11.0** (*live*, P0-07): 2025 era on HTTP and stdio, renders `structuredContent`, cannot elicit;
  `-e KEY=value` reaches a stdio server's environment.
- **Remote authentication**: static headers everywhere (JetBrains nests them under `requestInit.headers`; Claude Desktop
  and claude.ai allow a few headers in a beta UI); OAuth with DCR and CIMD in VS Code, Claude, Copilot CLI and Inspector;
  DCR plus static clients in Cursor; the Copilot cloud agent supports no OAuth (static headers from `COPILOT_MCP_*`
  secrets only).
- **Hosted Claude connectors** (claude.ai, desktop Chat tab, mobile) reach only public IPv4 HTTPS endpoints (private,
  CGNAT, loopback, link-local and IPv6-only hosts are refused) and use the fixed callback
  `https://claude.ai/api/mcp/auth_callback`.
- **Secrets in configuration**: VS Code prompts and stores secrets (`inputs` with `password: true`); Cursor, JetBrains and
  Inspector headers are stored in plain text; Claude Code blanks credential-like variables referenced from a project
  `.mcp.json` for remote servers and keeps OAuth tokens in the OS keychain.
- **Windsurf** became **Devin Desktop** (Cascade agent removed 2026-09-08; configuration moved from
  `~/.codeium/windsurf/mcp_config.json` to `~/.config/devin/mcp_config.json`).

## 4. OAuth 2.1 for MCP

- **Protected resource metadata** (RFC 9728): a 401 carries `WWW-Authenticate` with `resource_metadata`; otherwise
  clients try `/.well-known/oauth-protected-resource/{path}` and then the root. The metadata must list at least one
  authorization server. — [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
  [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)
- **Resource indicators** (RFC 8707) are required on authorization and token requests, and clients send `resource` again
  on refresh; tokens must be audience-bound to the exact MCP resource URL. — [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)
- **Authorization server discovery**: RFC 8414 metadata first, OpenID discovery second; clients validate the RFC 9207
  `iss` response parameter when advertised. — [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414),
  [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)
- **Client ID Metadata Documents** (CIMD) are the preferred registration: the `client_id` is an HTTPS URL whose JSON
  document (recommended ≤ 5 KiB) lists `client_name` and `redirect_uris`; the `client_id` must equal the document URL.
  Servers must treat fetching it as an SSRF risk and should show the redirect host. **Dynamic Client Registration**
  (RFC 7591) remains for compatibility. — [CIMD draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/),
  [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)
- **PKCE** S256 should be required for every client, including confidential ones; token endpoints take
  `application/x-www-form-urlencoded`.
- **Refresh-token rotation** with a reuse interval: identity providers commonly allow 0–60 s (Okta's default 30 s) for
  concurrent refreshes. — [Okta refresh tokens](https://developer.okta.com/docs/guides/refresh-tokens/main/)
- **Claude hosted clients** (claude.ai web, Claude Desktop remote connectors, Claude mobile) share one OAuth client:
  CIMD `https://claude.ai/oauth/mcp-oauth-client-metadata`, callback `https://claude.ai/api/mcp/auth_callback`; they
  need an internet-reachable HTTPS URL, use only the first authorization server listed, and allow about 10 s for
  discovery, registration and token calls (30 s for refresh). Claude Code's CIMD is
  `https://claude.ai/oauth/claude-code-client-metadata` with a loopback callback. —
  [Claude connector authentication](https://claude.com/docs/connectors/building/authentication) *(re-verify)*
- **Consent pages** must work in mobile browsers: a CSP `form-action 'self'` blocks a consent POST that redirects to a
  loopback callback, so the callback origin must be allowed (IPv6 literals need the `http:` scheme source).
- **Cloudflare `workers-oauth-provider`** (1.2.x) implements DCR, CIMD, PKCE S256, RFC 9207, refresh rotation and
  revocation, accepts only form-encoded token requests, and its code exchange is not atomic on KV (add a single-use
  marker). — [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) *(re-verify in P0-08)*

## 5. Cloudflare Workers platform

Checked 2026-10 in Cloudflare documentation; P0-09 measures with Agility-shaped payloads.

- **Workers limits**: Free — 100,000 requests/day, 10 ms CPU per request, 50 external subrequests (plus 1,000 to
  Cloudflare services), 128 MB memory, 6 simultaneous open connections; Paid — 30 s default CPU (configurable up to
  5 min), 10,000 subrequests (configurable), no daily request cap. —
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- **D1**: no interactive transactions (`batch()` is one transaction); statement size ≤ 100 KB; ≤ 100 bound parameters;
  rows/strings ≤ 2 MB; 30 s per query; read-only queries retried by the platform, writes not; foreign keys enforced;
  Free: 5 M rows read and 100,000 written per day. — [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- **Durable Objects** (SQLite-backed on Free): good for an exact deployment-wide limiter; each call is billed and placed
  near the first caller. — [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- **Rate Limiting binding**: `limit({ key })` → `{ success }`, periods of 10 or 60 s, per location and eventually
  consistent — a backstop only. — [Rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- **Cache API**: per data centre, not replicated; counts toward subrequest limits; unavailable behind Cloudflare Access
  *(unverified)*. On `workers.dev` it **worked** in P0-09 (`put` then `match` hit within and across requests, Free plan,
  2026-10-20, *live*); a custom domain is still to check (P3-03). —
  [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- **Cross-request I/O**: a promise for I/O started by one request must not be awaited by another (it can hang or fail).
- **Outbound TLS**: Workers verify publicly trusted certificates only; there is no option to trust a private CA for
  `fetch`, and private networks are reachable only through Cloudflare connectivity products (e.g. a tunnel). On-premises
  instances with a private CA therefore need the Node/Docker deployment ([ADR-0014](adr/0014-supported-agility-installations.md)).
  *live, P0-09:* a deployed Worker gets **HTTP 526** for self-signed, untrusted-root and expired certificates (local
  workerd throws an opaque error instead, L-160).
- **No `DOMParser`** in Workers: XML from `meta.v1`, `Hist` and `rest-1.v1` needs a pure-JavaScript parser with entity
  expansion disabled. P0-09 chose **saxes 6** (streaming, 8 KB gzip, refuses custom and external entities, about 1 ms
  for an 83 KB `meta.v1/Story`) and prefers JSON wherever Agility serves it. *live, P0-09*
- **Measured in P0-09** (2026-10-20, [results](../spikes/workers-limits/RESULTS.md)): `meta.v1` for all 175 asset types
  is 4.1 MB of XML or 4.8 MB of JSON (one type about 83–97 KB), so a Worker loads metadata per asset type; read + parse +
  shape costs about 3.5–4.5 ms per MB on Node and **about 8 ms per MB on a deployed Worker** (Free plan: 4 ms p50 /
  8 ms p99 at 512 KiB, 8 / 18 ms at 1 MB, 39 / 56 ms at 5 MB, nothing terminated), so the 512 KiB Free cap stands; the
  Rate Limiting binding let 8 of 10 calls through against a limit of 5 per 10 s (a backstop only); an untrusted certificate fails `fetch` on workerd with an opaque `internal error;
  reference = …` (L-160); local D1 and `node:sqlite` agree on STRICT tables, foreign keys, `ON CONFLICT … DO UPDATE …
  WHERE … RETURNING` and JSON functions, but D1's `meta.changes` includes cascaded rows (L-161). *live (local), P0-09*
- **Browser Integrity Check / bot protection** on custom domains can answer non-browser MCP clients with error 1010 or
  403; a WAF exception for the MCP paths is needed.

## 6. Node.js, Docker, SQLite, npm and registries

- **Node 24 LTS** ships `node:sqlite` (synchronous SQLite, D1-compatible SQL). Its stability index is below "Stable"
  (release candidate at the time of writing, *verify*): pin a minimum Node 24 minor and test the next LTS before
  claiming support for it. The distroless image
  `gcr.io/distroless/nodejs24-debian13:nonroot` includes it, has no shell, and needs a Node-based healthcheck. —
  [Node.js sqlite](https://nodejs.org/api/sqlite.html)
- **Custom CAs on Node**: `NODE_EXTRA_CA_CERTS` adds CA certificates at process start; a per-instance CA needs an
  undici `Agent` with `connect: { ca }` passed to `fetch`'s dispatcher (Node-only code, injected into the core). —
  [Node CLI docs](https://nodejs.org/api/cli.html#node_extra_ca_certsfile)
- **npm trusted publishing** (OIDC from GitHub Actions) needs npm CLI ≥ 11.5.1 and a GitHub-hosted runner; **staged
  publishing** keeps a published version private until a maintainer approves it with 2FA. —
  [trusted publishers](https://docs.npmjs.com/trusted-publishers), [staged publishing](https://docs.npmjs.com/staged-publishing) *(re-verify)*
- **npm staged publishing, observed 2026-10-19** (npm CLI 11.16.0, publishing `agility-bridge@0.0.0`): staged
  publishing needs npm CLI ≥ 11.15.0 (`npm stage publish|list|view|download|approve`). The first publish of a new name
  created a public stub `0.0.0-stage` ("Temporary package placeholder for staged publishing"). Approval asked for
  browser-based 2FA, which fails with `EOTP` in a non-interactive shell; once approved, the version became `latest`. —
  [staged publishing](https://docs.npmjs.com/staged-publishing), live
- `pnpm pack` resolves `workspace:` dependencies and adds the root `LICENSE`, but not `NOTICE` or `README.md`; include
  them explicitly.
- **MCP Registry**: servers are described by a `server.json` (package, transport, environment variables marked secret or
  not) and published under a namespace such as `io.github.<owner>/<name>`. —
  [MCP Registry](https://registry.modelcontextprotocol.io/)
- **OS keychains** without native modules: macOS `security` (read commands from stdin with `-i` so secrets never appear in
  argv), Linux `secret-tool` (Secret Service), Windows PowerShell `PasswordVault`/Credential Manager. `keytar` is
  archived.

## 7. Prior art

- **No maintained open-source MCP server for Digital.ai Agility or VersionOne was found** (searched GitHub, npm, PyPI, the
  MCP Registry, Smithery, Glama, mcp.so, PulseMCP and the Docker MCP catalog, October 2026). The only public artifact is
  [Quantiser/mcp-server](https://github.com/Quantiser/mcp-server): a single-commit Python prototype from 2025-07-30 with
  four read-only tools for stories and epics, no license and no activity since.
- Name collisions to keep in mind: **Agility CMS** (an unrelated headless CMS with its own MCP server) and **Agility PR
  Solutions** (unrelated). Package descriptions must say "Digital.ai Agility".
- **Digital.ai** offers an official MCP server for its **Release** product, not for Agility. —
  [Release MCP server](https://docs.digital.ai/release/docs/next/how-to/release-mcp-server)
- **Comparable work-management MCP servers** (GitHub, Atlassian Rovo, Azure DevOps, Linear), the Agility SDKs and the
  Release MCP server were reviewed in P0-10 (2026-10-20). None binds query values (JQL, WIQL and Agility `where` filters
  are strings the caller builds), and none ties write approval to the exact change; both are agility-bridge
  differentiators (ADR-0012, ADR-0013). The SDK pages never mention `query.v1` or `with` variables, so the binding
  behaviour remains a P0-06 question. Matrix, adopt / avoid / differentiate lists and follow-ups:
  [research/prior-art.md](research/prior-art.md).

## 8. Open questions for the Phase 0 spikes

**P0-06 (Agility API)** — on a hosted sandbox and, if available, an on-premises instance:

1. Confirm access tokens with `query.v1` on every instance version we support (documented as supported). Which errors
   and bodies come back for bad tokens, missing permissions, invalid attributes and unknown asset types (status, content
   type, shape)?
2. `with` binding in `query.v1` JSON: behaviour with quotes, commas, pipes, Unicode, very long strings and arrays.
3. Paging: maximum practical page size, `needTotal` cost, behaviour without `page`, stability of ordering.
4. Rate limits: which quotas apply to a sandbox, 429 body and headers, `RetryAfter` accuracy, error-count quota behaviour.
5. Latency and response size per endpoint for typical queries (list 25/100 work items with owners and status).
6. Number prefixes: how to learn them per instance; resolving an unknown number across asset types in one query.
7. Relations: exact names for task/test parents, children, portfolio tree, owners, team, timebox, status per type.
8. Custom fields: discovery through `meta.v1`, types, value formats.
9. `meta.v1` size and caching: how to detect metadata changes (version, ETag, hash).
10. Writes in the sandbox: `api/asset` single-target update vs `rest-1.v1` POST; `previewOnly=true` guarantees; creating
    comments (`Expression`), effort (`Actual`) and links; operations (`QuickClose`, `Reactivate`); response bodies;
    read-after-write lag.
11. History: `Hist` vs `asof` cost; activity stream completeness.
12. `assetdetail.v1` links for every asset type; attachments metadata.
13. On-premises differences: version, TLS/custom CA, base-URL shapes, Windows authentication interplay with access
    tokens.

**P0-07 (SDK and clients)**, **P0-08 (OAuth)** and **P0-09 (Workers limits)**: see the task files.
