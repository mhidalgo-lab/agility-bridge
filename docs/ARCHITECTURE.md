# Architecture

> Status: **design draft** (2026-10-16). Decisions are recorded in [`adr/`](adr/); platform facts are in
> [`RESEARCH.md`](RESEARCH.md); the rules learned the hard way are in [`LESSONS-LEARNED.md`](LESSONS-LEARNED.md).
> Nothing here is implemented yet; section numbers are referenced by tasks.

## 1. Goals and non-goals

**Goals**

1. Let AI agents work with **Digital.ai Agility** — every asset type: backlog items/stories, defects, tasks, tests,
   epics and portfolio items, issues, requests, regression tests/plans/suites, test sets, sprints/iterations, teams,
   members, projects, every other asset type the instance's metadata exposes, and custom fields — through the member's
   own **access token**.
2. Run **anywhere**:
   - local stdio started by the MCP client (no account, no database);
   - a self-hosted Node or Docker HTTP server, inside a company network if needed;
   - a Cloudflare Worker reachable from every device (laptop, IDE, phone, claude.ai).
3. **Share across teams**: several Agility instances and workspaces from one deployment, each workspace at its own URL.
4. A fine-grained **access model**: which Agility credential a client uses, which Agility projects (scopes), asset
   types and tools it may use, and with which limits.
5. **Read-only by default**; typed, opt-in **write tools** with human approval.
6. Treat security as a feature: encrypted tokens, audit log, documented threat model, untrusted-content handling.

**Non-goals (for 1.0)**

- Replacing the Agility UI, its analytics or the Data Mart. Reports are composed from API queries and the agent does
  the reasoning.
- A raw API passthrough tool ([ADR-0012](adr/0012-structured-query-no-raw-passthrough.md)).
- Deleting assets, or multi-asset (where-based) mutations ([ADR-0013](adr/0013-opt-in-writes-human-approval.md)).
- Processing webhooks or running background jobs beyond housekeeping (audit purge, key rotation).
- Basic or Windows authentication to Agility ([ADR-0014](adr/0014-supported-agility-installations.md)).
- Multi-tenant SaaS for strangers: agility-bridge is software you self-host (personal, team or company).

## 2. Component overview

```
              ┌───────────────────────── MCP clients ─────────────────────────┐
              │ GitHub Copilot (VS Code, JetBrains, CLI) · Claude Code/Desktop │
              │ claude.ai · Claude mobile · Cursor · Windsurf · MCP Inspector  │
              └──────────┬──────────────────────────────────────┬─────────────┘
                    stdio│                                 HTTPS│ /w/{slug}/mcp
              ┌──────────▼─────────┐   ┌────────────────────────▼──────────────────────────┐
              │ apps/cli           │   │ packages/http-app (Hono)                          │
              │ stdio · serve ·    │   │ /w/:slug/mcp  /admin  /api/admin  /oauth/*        │
              │ manage · doctor    │   │ /.well-known/*  /approve/*  /health                │
              └──────────┬─────────┘   └──────┬───────────────────────┬────────────────────┘
                         │                    │ authn / authz          │
                         │             ┌──────▼──────┐          ┌──────▼──────┐
                         │             │ packages/   │          │ packages/   │
                         │             │ auth        │          │ admin-ui    │
                         │             └──────┬──────┘          └─────────────┘
              ┌──────────▼────────────────────▼────────────────────────────────┐
              │ packages/core                                                   │
              │ tool registry · Agility client · metadata service · query      │
              │ compiler · asset identity · output shaper · budget · limiter   │
              └──────────┬──────────────────────────────────────┬──────────────┘
                         │                                      │
              ┌──────────▼───────────┐               ┌──────────▼──────────────────┐
              │ packages/storage     │               │ Digital.ai Agility instance │
              │ yaml │ sqlite │ d1   │               │ query.v1 · meta.v1 ·        │
              └──────────────────────┘               │ rest-1.v1 · api/asset       │
                                                     └─────────────────────────────┘
   Hosts: apps/cli (Node: stdio + `serve`) · apps/worker (Cloudflare) · Docker image (Node)
```

| Package | Responsibility | Runtime constraints |
|---|---|---|
| `packages/core` | Tool definitions and registry, Agility HTTP client, metadata service (`meta.v1`), query compiler, asset identity and name resolution, output shaping and untrusted-data envelope, budget, concurrency limiter, error model, prompts, resources | **Web-standard APIs only** (`fetch`, WebCrypto, `URL`, streams); a lint rule bans `node:*`, `process`, `Buffer`. Clock, randomness, storage and outbound fetch are injected. |
| `packages/storage` | `Storage` interface, Drizzle schema, embedded migrations; adapters `memory`, `yaml` (read-only), `d1` | Web-standard; adapters are the only runtime-specific code. |
| `packages/storage-sqlite` | `node:sqlite` adapter, file permissions, backups | Node only. |
| `packages/auth` | Device tokens, effective-permission resolver, identity providers (Google, GitHub, Cloudflare Access, OIDC), admin sessions, OAuth 2.1 integration | WebCrypto only. |
| `packages/http-app` | Hono app: routing, middleware (security headers, Host/Origin, body caps, auth, rate limits, audit), MCP handler per workspace, admin REST API | Runs on Workers and on Node through `@hono/node-server`. |
| `packages/admin-ui` | Server-rendered admin panel (Hono JSX), static assets with hashes, mounted at `/admin` | No inline scripts or styles; strict CSP; auto-escaping only. |
| `apps/cli` | `agility-bridge` binary: `stdio` (default), `serve`, `init`, `doctor`, management commands, keychain | Node 24 LTS. The only published npm package at first. |
| `apps/worker` | Cloudflare entry, bindings, `wrangler` config, setup script | Workers runtime. |
| `site/` | Documentation site (Phase 9) | Static. |

## 3. Deployment modes

| Mode | Storage | Client authentication | Who it's for |
|---|---|---|---|
| **A. stdio, environment** | none | none (local process) | Fastest start: `npx agility-bridge` with `AB_AGILITY_URL` and `AB_AGILITY_TOKEN` in the client's `env` block |
| **B. stdio, config file** | `yaml` (read-only; tokens from env or keychain references) | none | Several instances or workspaces locally, one workspace per process (`AB_WORKSPACE`) |
| **C. Self-hosted HTTP** (`agility-bridge serve`, Docker) | `sqlite` | device tokens → OAuth | A team or company server, possibly next to an on-premises Agility instance |
| **D. Cloudflare Worker** | `d1` | device tokens → OAuth | Reachable from every device including phones and claude.ai, no server to run |
| **E. Pass-through workspace** (optional on C/D, off by default) | none for Agility tokens | on the workspace's normal URL, the client sends its own Agility token in `X-Agility-Token` instead of a device token; every workspace control applies (Agility projects, asset types, tools, limits, rate limits, audit by token fingerprint) | A simple shared team server where no token is stored; read-only in 1.0 (P2-14) |

Modes C and D share all code except the storage adapter and the entry point. Mode D reaches only instances that are
internet-reachable with publicly trusted certificates; on-premises instances behind a private network or private CA
use modes A–C ([ADR-0014](adr/0014-supported-agility-installations.md)).

Both read the shared `AB_*` settings with one parser and assemble the app with one function (`packages/http-app`
`server.ts`, P3-01). On Workers the app runs with **request isolation** (L-096): no request awaits I/O another request
started. Audit writes are detached and kept alive with `waitUntil`, each call gets its own concurrency limiter,
metadata loads and pass-through validations are not shared in flight (completed values are), purpose keys are derived
at boot, and the boot itself runs inside a request and is cached only once it completed.

## 4. Access model

> **Terminology.** A **workspace** is agility-bridge's unit of access: what one MCP URL (`/w/{slug}/mcp`) exposes. An
> **Agility project** is Agility's `Scope` asset (shown as *Project* or *Planning Level* in the UI). They are named
> differently on purpose; tools always say "Agility project" or `project` for the latter.

```
User (identity via Google / GitHub / Cloudflare Access / OIDC)
 │ owns (personal)                       Instance ── Agility base URL + TLS options (owner/admin-defined)
 ▼                                          ▲
Credential ── Agility access token (encrypted) for one instance; personal or shared; validated → member id, name,
 │            reachable Agility projects
 │ used by
 ▼
Workspace ── slug (URL), instance, allowed Agility projects (scopes, ± children), allowed asset types, enabled tools
 │            (upper limit), limits, default shared credential (read-only), write policy
 │ has many
 ▼
Grant ── who (user or service) × workspace × credential × tools × Agility projects × asset types × limits × rate limits
 │        × expiry
 │ presented as
 ▼
Device token (`ab_live_…`, one per device)   or   OAuth device session (per app/device)
```

**Effective permissions for a request** ([ADR-0008](adr/0008-access-model.md)):

```
tools      = workspace.enabledTools ∩ grant.tools      write tools only when: server writes on, both lists name the
                                                       tool explicitly, the credential is the grant user's own, and
                                                       (OAuth) the token has mcp:write
projects   = workspace.allowedProjects ∩ grant.projects  ∩ what the token's member can see (enforced by Agility)
assetTypes = workspace.assetTypes ∩ grant.assetTypes
credential = grant.credential (personal) ?? workspace.defaultCredential (shared; read-only grants only)
limits     = workspace.limits tightened by grant.limits  numbers: min · allow lists: ∩ · deny lists: ∪
```

Resolved by a pure function, `resolveAccess` in `packages/auth/src/access` (P2-04), over the stored records, the
deployment's settings and the time: anything missing, disabled, revoked, expired, unvalidated or malformed denies, and
the audience is checked first. Project narrowing is by exact id (a grant names a subset of the workspace's projects); an
empty project list denies; the credential's last-validated reach only produces a warning, because Agility enforces the
member's visibility itself. The domain services next to it (`accessServices`) are the only writers of instances,
credentials, workspaces and grants, so the admin API, the CLI and imports share every rule (L-065). Guide:
[access model](guide/access-model.md). Rules:

- Tools a caller may not use are **not listed**; the MCP server is built per request with only the allowed tools, and
  calls to other tools are refused anyway (defence in depth).
- Each device has its own token or OAuth session, so losing a device means revoking one entry. Device tokens are
  `ab_live_<43 base62, 256-bit>_<CRC-32 in 6 base62>` (`ab_test_…` on non-production deployments); the checksum is checked before any storage read, then the
  SHA-256 is looked up and compared in constant time, then revocation and expiry; `last_used_at` is written at most once
  per 5 minutes.
- A token is bound to **one workspace** (its audience); using it at another slug is rejected with 401.
- Instances are defined by owners/admins only; members attach personal tokens to existing instances (P4-07).
- An instance's origin and TLS trust are **immutable while credentials exist**. Changing them is owner-only, needs a
  recent sign-in, revokes every credential and grant of that instance, and members must re-enter their tokens after
  reviewing the new origin; new origins are probed with an unauthenticated `meta.v1` request before any token is
  sent (THREAT_MODEL A14).
- Every alternate writer (admin API, CLI, import, panel) applies the same owner/admin guards (L-065).

### Data model (SQLite / D1)

`packages/storage/src/schema.ts` (Drizzle, SQLite dialect) with hand-written, embedded migrations in
`packages/storage/src/migrations/` (STRICT tables, CHECK constraints, triggers for the cross-row rules); a test keeps the
two identical. Times are epoch milliseconds, ids are caller-generated text, lists and objects are JSON text. Repository
semantics, rules and migrations: [dev/storage.md](dev/storage.md).

| Table | Key columns |
|---|---|
| `users` | id, email (lowercase, unique), display_name, idp + idp_subject (unique), role (`owner` \| `admin` \| `member`), created_at, updated_at, disabled_at |
| `instances` | id, label, base_url (canonical), tls (json: CA bundle reference, Node only), number_prefixes (json overrides), meta_fingerprint, created_at, updated_at, disabled_at |
| `credentials` | id, instance_id, owner_user_id (null = shared), label, token_ciphertext, token_iv, key_version, token_hint (last 4), validation_status (`unvalidated` \| `valid` \| `invalid`), validation_error_code, validated_at, member_oid, member_name, member_username, reachable_scope_ids (json), created_at, updated_at, revoked_at |
| `workspaces` | id, slug (unique), name, instance_id, allowed_scope_ids (json), include_child_scopes, asset_types (json, null = all), enabled_tools (json, null = all read tools), limits (json), default_credential_id (shared only), write_policy (json), created_at, updated_at, disabled_at |
| `grants` | id, workspace_id, user_id (null for service grants, which need a label), label, credential_id (null → workspace default), tools (json), scope_ids (json), asset_types (json), limits (json, tightening), rate_limit (json), created_at, updated_at, expires_at, revoked_at |
| `access_tokens` | id, grant_id, prefix, token_hash (SHA-256 hex, unique), label (device), created_at, expires_at, last_used_at, revoked_at |
| `audit_log` | id, ts, kind (`tool_call` \| `write` \| `auth` \| `admin`), action, status (`ok` \| `error` \| `denied`), request_id, user_id, grant_id, token_id, client_id, workspace_id, instance_id, asset_numbers (json, bounded), query (values masked), duration_ms, agility_requests, error_code, target_type, target_id, details (json). No foreign keys. |
| `settings` | key, value (json), updated_at |
| `kv` | key, value, expires_at — OAuth provider records (`oauth:`; codes and tokens stored hash-only, grant properties encrypted), single-use markers taken atomically, sign-in transactions, setup links, write approvals and replay ledger, cached client metadata documents, task records |
| `schema_migrations` | version, name, checksum, applied_at |

Deleting a workspace removes its grants and their tokens; deleting a grant removes its tokens; a credential, instance
or user still referenced cannot be deleted (revoke or disable it instead). Audit rows are never updated, and deleted
only by retention. Storage itself refuses a workspace default that is not a shared credential of the workspace's
instance, a grant credential that is neither shared nor the grant user's own, and a change of an instance's origin or
TLS trust while it has unrevoked credentials (P2-01).

## 5. Request flow (remote MCP call)

1. `POST /w/{slug}/mcp` reaches the Hono app: request id, security headers on every response (HSTS derived from the
   public URL), `Host`/`Origin` allowlists (DNS rebinding), CORS only when configured, declared body size ≤ 1 MiB,
   JSON-RPC batches refused.
2. **Authenticate**: device token (format and checksum offline, then hash lookup, constant-time compare, revoked,
   expired) or, with OAuth on, a provider-issued access token validated for this slug's resource only (RFC 8707), with
   its props cross-checked. Every failure is the same 401 (with OAuth on, `WWW-Authenticate` names the slug's RFC 9728
   metadata).
3. **Resolve access**: effective tools, scopes, asset types, limits and credential (`resolveAccess`; one storage call,
   one D1 `batch()` on Workers), cached for at most 60 s (default 30 s), never past the token's or grant's expiry,
   keyed by token hash + slug, holding no plaintext token. Storage errors are 503.
4. **Rate limit**: per IP before authentication; failed authentications charged to the IP (valid tokens are never
   locked out); per token and per grant after resolution; 429 with `Retry-After`. `subscriptions/listen` is not counted
   as a tool call.
5. **Build the MCP server**: `createMcpHandler(factory, { legacy: 'stateless' })`; the per-request scope travels in
   `authInfo.extra` as a `ToolContext { credential (decrypted for this request), instance, scopes, assetTypes, limits,
   budget, limiter, metadata, logger, clock }`. Only granted tools, prompts and resources are registered;
   `listChanged: false` everywhere.
6. **Tool execution** in core: validate input (JSON Schema) → domain validation against instance metadata → compile
   the Agility request (bound values, scope predicate, explicit paging) → apply limits → Agility call(s) with timeout,
   retries and budget → verify returned scope → shape output.
7. **Shape output**: format, caps, truncation notice, untrusted-data envelope, `partial`/`notes`, identity columns.
   The whole exchange, including a streamed response, is bounded by a 180 s deadline.
8. **Audit**: one row per tool call, refusal and admin change, written in the background (`waitUntil` on Workers);
   write tools record the intent *before* the mutation and refuse if that fails.

Implemented in `packages/http-app` (`createHttpApp`, P2-06) and served on Node by `agility-bridge serve`
(`apps/cli/src/serve.ts`): only `POST` reaches the SDK (stateless HTTP has no `GET` stream or session to `DELETE`:
405); the body is read with the cap, parsed, refused if it is a batch, and classified from the body (`tools/call`,
`subscriptions/listen`, notifications, lists, lifecycle, tasks) before the rate-limit hooks (P2-07) and the observer
(audit, P2-08) see it. Every denial is the same `401` with `WWW-Authenticate: Bearer`; refusal reasons go only to the
observer. Node also bounds sockets (`headersTimeout` 20 s, `requestTimeout` 60 s).

stdio (modes A/B) runs steps 5–7 with a context built once at startup from the environment or YAML file; there is no
storage, no audit table (write outcomes are logged to stderr) and no HTTP layer.

## 6. The Agility layer (`packages/core`)

### 6.1 Agility HTTP client (P1-02)

`packages/core/src/agility/`. Tools get it with `agilityClient(ctx)`; it has no other entry point.

- One client per call, created from the `ToolContext`: canonical instance base URL, the resolved credential, the budget,
  the limiter, the breaker and the `fetch` the host pinned with the instance. Tools never build URLs or headers
  (L-152: one identity per call). Endpoints are fixed (`query.v1`, `query.legacy.v1`, `meta.v1/<type>`,
  `rest-1.v1/Data|Hist/<type>/<id>`, `rest-1.v1/Data` POST and `api/asset` for writes); asset types, ids, attribute
  selections and operation names are validated before they reach a path or `sel`.
- Instance URLs are canonicalised at configuration time (`canonicalInstanceUrl`): HTTPS only (HTTP for loopback
  tests), no user info, query or fragment, path kept, no trailing slash.
- Headers: `Authorization: Bearer <access token>`, `Accept: application/json` (every read endpoint answers JSON, P0-06),
  `User-Agent: agility-bridge/<version>`, `Content-Type` per endpoint.
- **Redirects are never followed** (`redirect: 'manual'`); any redirect is reported as a likely instance-URL mistake
  (`AB_AGILITY_WRONG_INSTANCE`), and so is an HTML page or a body that is not JSON.
- Timeouts: 20 s per request, body included (`limits.requestTimeoutMs`), within the 180 s exchange deadline. A timeout
  is not retried.
- **Retries** (ADR-0010): reads only, on 429/502/503/504 and network errors, ≤ 3 attempts, full-jitter backoff from
  500 ms, honouring `Retry-After` (seconds or a date) or the 429 body's `RetryAfter`, refusing waits above 10 s (the
  error reports `retryAfterSeconds`); each attempt spends budget, so a budget that runs out mid-retry ends with
  `AB_BUDGET_EXHAUSTED`. Writes are sent once.
- **Circuit breaker** (`CircuitBreakers`, owned by the host per process): keyed by instance **and credential**; three
  consecutive 429s open it for at least 30 s (or the longer `Retry-After`); while open, calls fail fast with
  `AB_AGILITY_RATE_LIMITED` without spending budget or reaching Agility. One member's throttling never blocks another.
- **Concurrency**: per-credential semaphore (`CredentialLimiters`, default 5; ≤ 6 on Workers), owned by the host.
- **Response caps**: bodies are stream-read with a byte cap before parsing (`limits.maxResponseBytes`; a larger
  `Content-Length` is refused before reading) and the stream is cancelled at the cap; error bodies are read up to
  64 KiB. JSON is parsed natively; XML (`rest-1.v1` write answers) by saxes with document types refused, so no entity
  is ever declared or expanded (no `DOMParser` on Workers).
- **TLS**: verification always on. On Node, `AB_CA_FILE` adds a private CA bundle to the public roots through an undici
  dispatcher (`apps/cli/src/agility-fetch.ts`, ADR-0014). A Worker gets HTTP 526 for an untrusted certificate and local
  workerd an opaque `internal error`; both, and Node's certificate error codes, map to `AB_AGILITY_TLS` (L-160).
- **Error mapping**:

| Agility response | Error code | Message hint |
|---|---|---|
| 401 (24-byte JSON, no `WWW-Authenticate`) | `AB_AGILITY_AUTH` | token invalid or revoked, or for another instance; recreate it from the Agility Applications page |
| 403 | `AB_AGILITY_AUTH` | the token works but its member lacks the permission |
| 404 | `AB_NOT_FOUND` | "Not found or not visible with this token" (L-140) |
| 400 / 405 / other 4xx (`{error, exceptions[]}`) | `AB_AGILITY_ERROR`, Agility's messages as untrusted details | check attribute names and values against the metadata |
| 429 | `AB_AGILITY_RATE_LIMITED` with `retryAfterSeconds` | tenant quota; wait, narrow the request |
| 500, 502/503/504 after retries, network | `AB_AGILITY_UNAVAILABLE` | |
| timeout | `AB_AGILITY_TIMEOUT` | narrow the request |
| redirect / HTML page / non-JSON body | `AB_AGILITY_WRONG_INSTANCE` | check the instance URL (L-054) |
| HTTP 526 (Workers), workerd `internal error`, Node certificate errors | `AB_AGILITY_TLS` | the certificate is not trusted; private CAs need `AB_CA_FILE` on the Node/Docker deployment (L-160) |
| response over the cap | `AB_LIMIT_RESPONSE_TOO_LARGE` | fewer rows or fields |

Raw Agility bodies are never returned to the client: the messages of a 400 travel only as untrusted error details
(shown through the untrusted-data envelope, P1-05), and bodies are logged redacted and truncated at debug level only.

### 6.2 Metadata service (P1-03)

`packages/core/src/metadata/`. The host owns one `MetadataService` per process; tools use `metadataFor(ctx)`.

- Fetches `meta.v1/<Type>` as JSON, **one asset type at a time** (the whole schema is 5.1 MB, P0-06), with the calling
  tool's context: every load is charged to that call's budget, concurrent calls share one load, and later calls reuse
  the cache (TTL 1 hour). The `ETag` (`"<version>.<schema stamp>"`) is the schema fingerprint: a new one drops every
  cached type, status list and prefix map of the instance. An unknown type is cached as absent (`meta.v1` answers 404).
- Parses asset types (`Token` is the type name; `Name` is a reference to its Name attribute), base type, abstract flag,
  attributes (kind from `AttributeType`, relation target, multi-value, custom, read-only, required) and operations.
  **Only identifiers are kept**, each checked against a strict pattern; display names and descriptions are dropped
  because administrators can edit them (THREAT_MODEL A12).
- `resolvePath(type, path)`: `.` follows relations, `Rel:Type` downcasts to a subtype of the relation's target (walking
  `Base`), a final `@Count`/`@Sum`/`@Min`/`@Max`/`@Avg` aggregates a multi-value path, at most 5 segments; filters inside
  paths are refused (the compiler builds them, ADR-0012).
- **Number prefixes** (L-141): one `query.v1` call samples one number per numbered type (falling back to the types the
  metadata confirms if Agility refuses one), configuration overrides win, and the map is a hint only: resolution by
  number always confirms through a query (P1-06).
- **Status lists** per asset type from the `Status` relation's list type, in `Order`, with `Inactive`, the owning `Team`
  (team workflows) and, where the list type has `RollupState`, the rollup category (L-142).
- **Field tiers** (`minimal`, `default`, `full`) computed from the attributes the type has, preferring the `…UTC` dates
  (L-149), with custom attributes only in `full` and `full` capped at `limits.maxFields`; overrides are validated.
- **Scope strategy** (below) classified from metadata: a single `Scope` relation to `Scope` is direct; `Attachment`,
  `Link`, `Actual` and `Expression` use a derived path that must resolve on the instance; `Scope` and `Timebox` (through
  `Schedule`) are workspace-bounded; `Member`, `Team` and every `List` subtype are global; abstract and unclassified
  types are denied.
- **Snapshot and drift** (L-053): a synthetic `meta.v1` snapshot of the 33 types the tools rely on is committed
  (`packages/core/test/fixtures/agility/meta-snapshot.json`). Its product attributes match the public example instance
  (26.2) and the read-only tenant (26.0.3.2). `pnpm metadata:drift` and the weekly *Metadata drift* workflow compare it
  with the public example instance; the live suite compares it with the tenant. Both report product attribute names
  only.

### 6.3 Query compiler (P1-04)

`compileQuery(ctx, input)` in `packages/core/src/query/` turns the structured input of read tools into `query.v1` JSON
([ADR-0012](adr/0012-structured-query-no-raw-passthrough.md)):

1. Validate `asset_type` against metadata and the workspace's allow/deny lists; refuse denied types, and global types
   without an explicit allowance (`AB_AUTH_FORBIDDEN`).
2. Validate every field path (dot paths, downcasts, aggregations over one relation) through the metadata service;
   enforce `maxFields`, `maxNestingDepth` (relation hops, in selections and filters), `maxAggregations`,
   `maxAnyOfGroups`, 20 filters and 3 sort fields (`AB_LIMIT_QUERY` names the limit and its unit).
3. Validate every filter: operator allowlist (`eq`, `ne`, `lt`, `le`, `gt`, `ge`, `contains`, `in`, `is_set`,
   `is_not_set`), value type per attribute kind (text ≤ 1,000 characters without control characters, numbers, booleans,
   zoned ISO dates, `AssetState` codes, OID tokens for relations), ordering operators only on ordered kinds, `contains`
   only on text, `in` with 1–50 values; **a scalar containing a comma is refused** (Agility would split it, L-162).
4. Emit filter tokens that reference **`with` variables only** (`Status.Name=$v1`); `is_set` / `is_not_set` compare with
   a literal `""`. The `any_of` groups become one parenthesised entry (`((A=$v1;B=$v2)|(C=$v3))`).
5. Add the server-owned predicates as their **own top-level entries** of `filter`, over server-owned variables
   (`$ab_scope`, `$ab_state`, `$ab_deleted`). `query.v1` ANDs the entries of `filter` and honours parentheses
   (verified live, P1-04), so no caller OR reaches them. The Agility-project restriction follows the scope strategy as a
   plain list predicate (`Scope=$ab_scope`, `Asset:Workitem.Scope=$ab_scope`, `ID=$ab_scope`,
   `Schedule.ScheduledScopes=$ab_scope`) over the allowed projects and, when sub-projects are included, their
   descendants: the metadata service expands them once with `ChildrenMeAndDown` and caches the tree for 10 minutes
   (`Scope.ParentAndUp` predicates cost up to 5 s on large types, L-168). Dead assets are always excluded
   (`AssetState=$ab_state` with `0`, `64`, plus `128` when closed items are asked for; `IsDeleted=false` for types
   without `AssetState`, such as `Actual`), and aggregations get a server-built bracket filter
   (`Children[AssetState!='Dead'].@Count`, L-143). The compiler also selects the scope field the recheck needs
   (`recheck`), exempt from the caller's limits.
6. Always set `page {start, size: limit + 1}` (L-137; "more available" without totals, L-163), a deterministic sort
   ending with `ID`, and no `needTotal`. Filters run in Agility before the page is cut (L-034).
7. Bound `as_of` (no future, at most `maxAsOfAgeDays`) and `time_range` windows (`maxTimeRangeDays`; one time model,
   L-061: `parseTimeRange`).
8. Return the masked query (every `with` value replaced by `…`) for `_meta` and the audit log, and a normalised form for
   the cursor binding (`cursorBinding`, `encodeCursor`, `decodeCursor`).

The live suite runs one compiled query per strategy and shape against the read-only tenant.

**Scope strategy per asset type.** Not every asset type has a direct `Scope` relation, so the metadata service
classifies each type, and the compiler enforces the class (unknown types are denied):

| Class | Examples | Enforcement |
|---|---|---|
| Direct | backlog items, defects, epics, issues, requests, test sets | predicate on `Scope` (and descendants when enabled) |
| Derived | tasks and tests (through their parent work item), attachments, links and effort records (through the asset they belong to), comments (through the asset they discuss) | predicate on the parent path, e.g. the parent's `Scope` |
| Workspace-bounded | sprints (through the schedules of allowed projects), Agility projects themselves | restricted to items related to the allowed projects |
| Global | members, teams, list types such as statuses and priorities | only through dedicated tools with minimised fields, or when the workspace explicitly allows the type in `query_assets` |
| Denied | administrative types (applications, grants, roles, …) and anything unclassified | refused |

Every class has negative-authorization tests (P2-12), and every returned row is rechecked (L-064).

### 6.4 Asset identity and name resolution (P1-06)

`packages/core/src/identity/`:

- `parseAssetRef` accepts asset numbers (`B-01234`, `S-01054`, `D-…`, `TK-…`, `AT-…`, `E-…`, any 1–4 letter prefix, case
  folded) and OID tokens (`Story:1234`, optionally with a moment `Story:1234:5678`, which is dropped for identity).
- `resolveAsset` resolves a number with **one compiled query**: against the type the prefix map hints at when exactly
  one type has that prefix, otherwise across `Workitem` (an abstract type compiled only by server code, with each row's
  concrete `AssetType` checked against the workspace's lists afterwards). OID tokens are checked the same way.
- Every query goes through the compiler (bound values, scope predicate), and **every row through `inScope`** against the
  compiled project set (L-064). An asset outside the workspace's projects, of a denied type, or missing all answer the
  same `AB_NOT_FOUND`: "not found or not visible with this token" (L-140).
- `resolveByName` (projects, teams, members, sprints) tries an exact query, then the longest word with `contains`
  (Agility splits bound values at commas, so names with commas match locally), then the first 50 names; matching is
  exact, then normalised (NFKC, case, punctuation, spacing), then trigram candidates. A fuzzy match is **never**
  picked: `AB_AMBIGUOUS` lists the candidates inside the envelope (L-036).
- `resolveMember` takes `me` (`IsSelf`), a username, or a name; `resolveSprint` takes a name or `current`, `previous`,
  `next` by dates (UTC), narrowed by team (`Workitems.Team`) or Agility project (`Schedule.ScheduledScopes`). Sprints
  of different schedules overlap: when the answer differs per schedule it is `AB_AMBIGUOUS`, and no current sprint is
  `AB_NOT_FOUND` with a hint. `resolveStatus` matches the instance's status list (L-142).

### 6.5 Output shaper (P1-05)

Implements [ADR-0015](adr/0015-tool-output-contract.md): text summary + `structuredContent` + `_meta`; formats; caps;
untrusted-data envelope with a random marker; HTML → plain text/Markdown for rich-text attributes; control and bidi
characters stripped; identity columns (`number`, `assetType`, `oid`, `state`, `project`); `partial`/`notes`;
`nextCursor`/`truncated`/`total`; member email minimisation; CSV formula neutralisation.

### 6.6 Writes (Phase 7)

Pipeline for every write tool ([ADR-0013](adr/0013-opt-in-writes-human-approval.md)):

```
validate input + metadata (operation allowed, attributes writable, values typed)
 → resolve target (number/OID) and verify scope
 → build canonical mutation (one target, explicit fields, old → new)
 → dry_run? return plan (+ whether approval is reachable)
 → confirm: true required
 → approval bound to hash(canonical mutation, actor, target, expiry); single-use ledger:
     elicitation when the request can be elicited, otherwise the out-of-band approval page (AB_WRITE_APPROVAL_PENDING)
     remote modes: ledger in `kv`, durable intent audit · stdio: in-process ledger, HMAC-signed state for
     multi round-trip requests, intent and outcome logged to stderr (documented as weaker)
 → re-read target; changed since plan → AB_WRITE_CONFLICT; already applied → idempotent no-op
 → audit intent (durable; failure → refuse)
 → send once (api/asset or rest-1.v1 per ADR-0011); never retried
 → audit outcome; result notes possible read lag (L-051)
```

## 7. Cross-cutting concerns

- **Budget** ([ADR-0010](adr/0010-platform-limits-strategy.md)): Agility requests per tool call. Presets: Node/stdio
  1,000; Workers Free 45; Workers Paid 1,000; `AB_CALL_BUDGET` overrides. Tools declare a worst-case cost; a tool whose
  cost exceeds the budget is not registered; composites plan in these units and degrade to `partial` results.
- **Query limits** (per workspace, tightened per grant): maximum `limit` per call (default 100, hard 1,000), maximum
  fields, nesting depth, aggregations and `any_of` groups, maximum history window and `asof` age, asset-type
  allow/deny lists, generic query tool on/off, maximum response bytes (512 KiB on Workers Free, 8 MiB otherwise),
  member emails on/off.
- **Cache** (Phase 8, P8-01): short-TTL read cache keyed by an HMAC over connection, credential, grant, scopes, limits
  and the normalised compiled query; authorised before lookup; never for writes.
- **Output contract**: [ADR-0015](adr/0015-tool-output-contract.md) and the [tool conventions](dev/tool-conventions.md).
- **Errors**: stable codes, mapped to tool results with `isError: true` (or JSON-RPC errors for non-tool methods),
  actionable messages, never secrets or raw upstream bodies:

| Code | Meaning |
|---|---|
| `AB_AUTH_UNAUTHORIZED` | No or invalid MCP credential, or stdio not configured (setup guidance in the message) |
| `AB_AUTH_FORBIDDEN` | Tool, Agility project or asset type not granted |
| `AB_TOOL_DISABLED` | Tool disabled for this workspace or deployment |
| `AB_INPUT_INVALID` | Input fails schema or metadata validation |
| `AB_NOT_FOUND` | Asset not found or not visible to this member |
| `AB_AMBIGUOUS` | A name matched several candidates (listed) |
| `AB_LIMIT_QUERY` | The query exceeds a workspace or grant limit |
| `AB_LIMIT_RESPONSE_TOO_LARGE` | Upstream response above the byte cap |
| `AB_LIMIT_RATE` / `AB_LIMIT_QUOTA` | Our rate limit or quota |
| `AB_BUDGET_EXHAUSTED` | The per-call request budget ran out |
| `AB_AGILITY_AUTH` | Agility rejected the token |
| `AB_AGILITY_RATE_LIMITED` | Agility returned 429 (`retryAfterSeconds` included) |
| `AB_AGILITY_TIMEOUT` / `AB_AGILITY_UNAVAILABLE` | Timeout / 5xx or network failure |
| `AB_AGILITY_TLS` | Untrusted instance certificate (Workers: HTTP 526 or an opaque fetch error, L-160) |
| `AB_AGILITY_WRONG_INSTANCE` | Redirect, login page or non-Agility response: check the instance URL |
| `AB_AGILITY_ERROR` | Other unexpected Agility response |
| `AB_WRITE_APPROVAL_PENDING` | Approval requested out of band: open the returned link, approve, then repeat the call |
| `AB_WRITE_APPROVAL_UNAVAILABLE` | Approval required but neither elicitation nor the approval page is available |
| `AB_WRITE_APPROVAL_DECLINED` | The user declined or did not answer |
| `AB_WRITE_CONFLICT` | The target changed between plan and apply |
| `AB_INTERNAL` | Unexpected error (reference id only) |

- **Observability**: structured JSON logs to stderr (redacted); audit log in remote modes; optional OpenTelemetry
  export, off by default (P8-07), with allowlisted attributes only and caller vs server fault classification.
- **Cryptography**: WebCrypto only; master key → HKDF-SHA-256 purpose keys; AES-256-GCM for stored tokens; SHA-256 for
  every issued bearer value; inventory kept in `docs/security/cryptography.md` from P2-15.
- **Configuration**: environment variables (prefix `AB_` for everything) and
  storage-backed settings, validated at boot; unknown keys rejected; secrets never accepted as CLI flags.

### 7.1 Planned configuration (initial list)

| Variable | Default | Meaning |
|---|---|---|
| `AB_AGILITY_URL` | — | stdio: instance base URL, e.g. `https://www7.v1host.com/MyCompany` |
| `AB_AGILITY_TOKEN` | — | stdio: the member's access token (secret) |
| `AB_CONFIG` / `AB_WORKSPACE` | unset | stdio: YAML file and the workspace to serve from it |
| `AB_PROJECTS` | all visible | stdio: allowed Agility projects (`Scope:1234,…`) |
| `AB_TOOLS` | all read tools | tool allowlist (unknown names fail at startup) |
| `AB_ASSET_TYPES_ALLOW` / `AB_ASSET_TYPES_DENY` | all / none | asset-type limits |
| `AB_GENERIC_QUERY` | `on` | enable `query_assets` / `get_assets` |
| `AB_MEMBER_EMAILS` | `off` | include member emails in output |
| `AB_ATTACHMENT_DOWNLOAD` | `off` | enable `get_attachment` (D-08) |
| `AB_ATTACHMENT_MAX_BYTES` / `AB_ATTACHMENT_TYPES` | `1048576` / text types | attachment content size cap and content-type allowlist |
| `AB_LIMITS_MAX_LIMIT` | `100` | maximum rows per call (hard 1,000) |
| `AB_LIMITS_MAX_RESPONSE_BYTES` | `8388608` (Workers Free 524288) | upstream response cap |
| `AB_CALL_BUDGET` | per runtime | Agility requests per tool call |
| `AB_CA_FILE` | unset | Node: PEM bundle trusted for the instance |
| `AB_WRITE_TOOLS` | `off` | server-level switch for write tools |
| `AB_WRITE_APPROVAL` | `required` | `required` \| `off` (warning at startup) |
| `AB_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `AB_DATA_DIR` / `AB_DB_PATH` | platform data dir | `serve`: SQLite location |
| `AB_HOST` / `AB_PORT` | `127.0.0.1` / `8787` | `serve`: listen address (loopback by default, L-082) |
| `AB_ENVIRONMENT` | `production` | `serve`: `production` issues `ab_live_` device tokens, `test` issues `ab_test_` |
| `AB_MASTER_KEY` / `AB_MASTER_KEY_FILE` (+ `_PREVIOUS`) | — | `serve`/Worker: encryption master key |
| `AB_PUBLIC_URL` | — | public origin (OAuth issuer, HSTS, links) |
| `AB_ALLOWED_HOSTS` / `AB_ALLOWED_ORIGINS` | loopback | Host/Origin allowlists |
| `AB_TRUSTED_PROXY_HOPS` | `0` | proxies trusted for the client IP |
| `AB_ACCESS_CACHE_TTL` | `30` | seconds (0–60) |
| `AB_ADMIN_TOKEN` / `AB_ADMIN_TOKEN_FILE` | unset | break-glass admin bearer |
| `AB_AUDIT_RETENTION_DAYS` | `90` | `0` keeps forever |
| `AB_RATE_LIMIT`, `AB_RATE_LIMIT_IP_PER_MINUTE`, `…_AUTH_FAILURES`, `…_TOKEN_PER_MINUTE`, `…_GRANT_PER_MINUTE` | `on`, 600, 10 per 5 min, 120, 300 | edge rate limits (P2-07, [configuration](guide/configuration.md#rate-limits)) |
| `AB_PASSTHROUGH` | `off` | enable mode E |
| `AB_OAUTH` | `off` | enable OAuth 2.1 (Phase 5) |
| `AB_PLAN` | `free` | Workers presets: `free` \| `paid` |
| `AB_LIVE_AGILITY_URL`, `AB_LIVE_AGILITY_TOKEN`, `AB_LIVE_SCOPE` | unset | live test suite only |

The generated configuration reference (P1-13) replaces this table once the code exists.

## 8. Tool catalogue (target)

Full list with inputs, risk class and phase: [reference/tool-catalogue.md](reference/tool-catalogue.md).

| Group | Examples | Phase |
|---|---|---|
| Discovery | `whoami`, `list_projects`, `list_asset_types`, `describe_asset_type` | 1 |
| Generic read (any asset type) | `query_assets`, `get_assets` | 1 |
| Work items | `search_work_items`, `get_work_item`, `list_my_work` | 1 |
| Planning context | `list_teams`, `get_team`, `list_sprints`, `list_members` | 1 |
| Portfolio, planning, collaboration, history | `get_sprint`, `list_portfolio_items`, `get_portfolio_tree`, `get_conversations`, `list_attachments`, `get_asset_history`, `list_recent_changes` | 6 |
| Attachment content (opt-in, off by default) | `get_attachment` | 6 |
| Reports (composites) | `sprint_health`, `standup_summary`, `release_readiness`, `defect_triage`, `work_item_quality` | 6 |
| Writes (opt-in) | `add_comment`, `update_status`, `log_effort`, `assign_owners`, `move_to_sprint`, `create_work_item`, `update_fields`, `close_asset`, `reopen_asset` | 7 |

Plus MCP **prompts** (workflows such as backlog-item quality review, sprint review, defect triage; registered only when
the tools they use are allowed), **resources** (filter cheat sheet, per-instance asset-type snapshots, status lists,
quality rubric), **MCP Apps** views (sprint burndown, status distribution; Phase 8) and the **Tasks** extension for
long reports (Phase 8).

## 9. Repository layout (target)

```
agility-bridge/
  apps/{cli,worker}/
  packages/{core,storage,storage-sqlite,auth,http-app,admin-ui}/
  site/                     documentation site (Phase 9)
  scripts/                  task tooling, generators, release helpers, checks
  e2e/                      Playwright + DAST
  docs/{ARCHITECTURE,RESEARCH,ROADMAP,THREAT_MODEL,LESSONS-LEARNED}.md
  docs/adr/NNNN-*.md
  docs/tasks/phase-N-*/PN-NN-*.md
  docs/pending-decisions/   owner questions
  docs/dev/                 contributor guides (tool conventions, testing, releasing, ...)
  docs/guide/               user guides (from Phase 1)
  docs/reference/           tool catalogue, client compatibility, generated references
  docs/security/            cryptography, logging and data-protection inventories (from Phase 2)
  AGENTS.md  CLAUDE.md  README.md  LICENSE  NOTICE  SECURITY.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md
```
