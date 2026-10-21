# Tool conventions

> Status: **final** (P0-11, 2026-10-21, owner sign-off in [pending decisions](../pending-decisions/phase-0.md)), with
> the facts the Phase 0 spikes measured. Enforced from P1-13 by the naming, description, secret-field and schema lints
> and the `tools/list` size test (see [Lints](#lints)) in `pnpm test`. A tool that breaks a rule fails the build: fix the
> tool, do not add an exception (L-030). Changes after this point follow [Deprecations](#deprecations).

One name per concept in every tool, so an agent that learned `asset` and `cursor` on one tool can call the next one
without reading its schema twice, and descriptions do not spend tokens explaining local spellings. Renaming or removing a
released argument or output field is a breaking change (see [Deprecations](#deprecations)).

## Tool names

- `snake_case`, verb first, stable:
  - `list_…` paged lists with filters; `search_…` free text plus filters; `get_…` one or a few items by identity;
    `query_assets` / `get_assets` the generic read tools; `describe_…` metadata;
  - reports are nouns: `sprint_health`, `standup_summary`, `defect_triage`;
  - writes: `add_…`, `update_…`, `create_…`, `log_…`, `assign_…`, `move_…`, `close_…`, `reopen_…`.
- Schemas use Agility API asset names (`Story`, `Defect`, `Task`, `Test`, `Epic`, `Timebox`, `Scope`); descriptions use
  the words users know first ("backlog item (story)", "sprint", "Agility project").

## Descriptions

- Start with the action and what is returned ("List open defects in an Agility project…"); never "This tool…" or
  "Use this…".
- At most about **450 characters**; say the scope ("within the workspace's Agility projects"), paging ("Paged: pass
  `nextCursor` back as `cursor`" or "Not paged: …"), side effects for writes ("Changes Agility. Needs approval."), and
  the cost when a call can make 8 or more Agility requests.
- Default values in descriptions and server instructions are generated from the schema, never typed by hand (L-150).
- Never put instructions about other content, secrets or examples with real data in descriptions.

## Arguments (input schema)

Arguments are `snake_case`. Prompt arguments use the same names.

| Concept | Name | Type | Notes |
|---|---|---|---|
| One asset | `asset` | string | An asset number (`B-01234`, `S-01054`, `D-00012`, `TK-…`, `AT-…`, `E-…`) or an OID token (`Story:1234`). Resolved by the shared resolver; scope verified. |
| Several assets | `assets` | string[] | At most 50. |
| Asset type | `asset_type` | string | Agility API name, validated against the instance metadata and the workspace's allow/deny lists. |
| Agility project | `project` | string | OID token (`Scope:1234`) or exact name (resolver; ambiguous → candidates). Must be inside the workspace's allowed projects. |
| Include sub-projects | `include_child_projects` | boolean | Default from the workspace. |
| Team | `team` | string | OID token or exact name. |
| Sprint / iteration | `sprint` | string | OID token, exact name, or `current` / `previous` / `next` (relative to `team`). |
| Member | `member` | string | OID token, username, or `me`. |
| Status | `status` | string[] | Names as configured on the instance (validated, case-insensitive); never hard-coded. |
| Status category | `status_category` | enum | `not_started` \| `in_progress` \| `completed` (the instance's rollup categories). |
| Free text | `contains` | string | Substring over the name (and the description where the tool says so). |
| Free text on one other field | `<field>_contains` | string | e.g. `description_contains`. |
| Fields to return | `fields` | string[] | Generic tools only; attribute paths validated against metadata. |
| Structured filters | `filters` | object[] | Generic tools only: `{ field, op, value }`, `op` ∈ `eq` `ne` `lt` `le` `gt` `ge` `contains` `in` `is_set` `is_not_set`. A scalar `value` must not contain a comma (Agility splits bound values at commas, L-162): `in` takes an array instead. |
| Alternatives | `any_of` | object[][] | Generic tools only; OR between groups of filters, AND inside a group; limited count. |
| Time window | `time_range` | string | e.g. `"last 14 days"`, `"2026-10-01 to 2026-10-15"` (UTC; L-061). |
| Point in time | `as_of` | string | ISO 8601 UTC; bounded by the workspace's history limit. |
| Include closed items | `include_closed` | boolean | Default `false`. |
| Most rows | `limit` | integer | Rows of the main list. A cap on something else is `max_<things>`. |
| Next page | `cursor` | string | The `nextCursor` of the previous call with the same filters. A tool takes `cursor` only if it returns `nextCursor`. |
| Fewer fields per row | `minimal_output` | boolean | |
| Output format | `format` | enum | `auto` \| `table` \| `csv` \| `json`. |
| Order (typed tools) | `sort_by` | enum | Tool-specific values; the default is the cheap, stable order (by `ID`, L-163). A value that sorts by change date says its cost in the description. |
| Order (generic tools) | `sort` | object[] | `{ field, direction: asc \| desc }`; fields validated against metadata. |
| Durations | `<thing>_hours`, `_days`, `_minutes` | number | Never `_h`, `_d`. |
| Write preview | `dry_run` | boolean | Write tools only. |
| Write confirmation | `confirm` | boolean | Write tools only; never treated as approval. |

Refused spellings (the lint lists them with their replacement): `id`, `oid`, `number` (→ `asset`), `guid`, `scope` (→
`project`), `iteration`, `timebox` (→ `sprint`), `owner`, `assignee` (→ `member`), `page`, `page_size`, `pageSize`,
`next_cursor`, `max_results`, `since`, `until`, `window`, `where`, `filter_expression`, `query` (no raw filters
anywhere, [ADR-0012](../adr/0012-structured-query-no-raw-passthrough.md)), and any secret-like name (`token`, `api_key`,
`apiKey`, `password`, `secret`, `authorization`), which the registry refuses outright (L-070).

## Structured output (`structuredContent`)

Output keys are `camelCase` at every depth. Output schemas are **open** (extra properties allowed) and evolve
additively (L-017). **No `null` in schemas:** a value that is absent is omitted (the property is optional), never
`null`, and schemas never use `type` arrays such as `["string", "null"]`, which clients with single-type schema dialects
reject (P0-07 finding 8). "Unknown" and "none" are distinguished by an explicit field where it matters (e.g. `state:
unknown`), not by `null`.

| Concept | Name | Type | Notes |
|---|---|---|---|
| Asset number | `number` | string | |
| Asset type | `assetType` | string | API name. |
| OID token | `oid` | string | Without the moment suffix. |
| Name / title | `name` | string | Untrusted text. |
| Lifecycle | `state` | enum | `future` \| `active` \| `closed` \| `template` \| `broken_down` \| `deleted` \| `guest_collaborator` (members) \| `unknown`, from `AssetState`; `stateCode` carries the raw number. |
| Status | `status` | string (optional) | The configured name; omitted when the asset has none. |
| Agility project | `project` | `{ oid, name }` | |
| Owners | `owners` | `{ oid, name, username, email? }[]` | `email` only when the workspace enables it. |
| Timestamps | `createdAt`, `changedAt`, `closedAt` | string | ISO 8601 UTC (L-149). |
| Effort | `estimate`, `detailEstimateHours`, `toDoHours`, `actualHours` | number (optional) | Omitted when not set; `estimate` keeps the instance's estimate unit, reported once in `_meta`. |
| UI link | `url` | string | Built from the pinned instance origin (`assetdetail.v1`). |
| More pages | `nextCursor` | string (optional) | Present only when more rows exist (the tool fetches `limit + 1`); pass back as `cursor`. |
| Deliberately bounded list | `truncated` | boolean | Never `hasMore`, never together with `nextCursor`; the text says how to see the rest. |
| Total matches | `total` | integer (optional) | Only when the tool actually computed it (e.g. an aggregate). Agility 26.0.3.2 returns no totals for lists (P0-06), so lists normally omit it and rely on `nextCursor`; never a guess or `-1` (L-144). |
| Rows dropped for being outside scope | `hiddenOutsideScope` | boolean | On every list that rechecks scope after fetching (L-064). |
| Not everything ran | `partial` + `notes` | boolean + string[] | Whenever paging, permissions, limits, budget or a failed section prevent a complete answer (L-033). |
| Window actually read | `since`, `until` | string | Resolved bounds, not the expression typed. |
| Write outcome | `applied`, `approval`, `plan` | | `approval`: `approved` \| `not_required` \| `dry_run`; see ADR-0013. |

Text output: a one-line summary, `Note:` lines, then the data block(s) in the requested `format`, each inside the
untrusted-data envelope ([ADR-0015](../adr/0015-tool-output-contract.md)).

## Paging

- Every list takes `limit` (default 25, maximum the workspace limit) and either pages or says why it is bounded.
- Agility paging is offset-based (`page {start, size}`); the tool always sends an explicit size (L-137) and a
  deterministic sort ending with `ID` as the unique tiebreaker (pages measured disjoint and repeatable, P0-06), and
  notes that concurrent edits can move items between pages. "More available" comes from fetching `limit + 1` rows:
  Agility does not report totals (P0-06).
- A cursor is client input, so it is never trusted for scope: `base64url(JSON)` carrying the offset, the first call's
  resolved window and a **binding** hash of tool + workspace + Agility projects + asset type + normalised filters + sort.
  A cursor from another tool, workspace or filter set, or a malformed one, is refused with `AB_INPUT_INVALID` before any
  request; offsets are range-checked; the window of the first call is kept (`time_range` is ignored once a cursor is
  passed, and descriptions say "keeps the first window").

## Errors

- Stable codes (`AB_*`, the final list below); result `isError: true`, text `CODE: message`, optional `Hint:` line;
  `_meta["agility-bridge/error"] = { code, requestId }`.
- Messages are actionable for the agent and never contain secrets, tokens or raw Agility bodies; names and candidates
  inside an error are enveloped.
- Non-tool methods (prompts, resources) use JSON-RPC errors: `-32602` for invalid parameters, `-32603` with
  `data.code` for limits, budget, rate, quota and upstream failures (L-019).
- A write never asks for approval a client cannot give: the framework checks the request's declared elicitation
  capability first and answers `AB_WRITE_APPROVAL_UNAVAILABLE` (or the approval page) itself, because the SDK turns an
  unanswerable `inputRequired` into a protocol error on 2026-07-28 (P0-07 finding 7).

### Error codes (final)

| Code | When |
|---|---|
| `AB_AUTH_UNAUTHORIZED` | No or invalid MCP credential, or stdio not configured (setup guidance in the message) |
| `AB_AUTH_FORBIDDEN` | Tool, Agility project or asset type not granted |
| `AB_TOOL_DISABLED` | Tool disabled for this workspace or deployment |
| `AB_INPUT_INVALID` | Input fails schema or metadata validation (including a comma in a scalar filter value, a cursor from another call) |
| `AB_NOT_FOUND` | Asset not found or not visible to this member (Agility does not distinguish them, L-140) |
| `AB_AMBIGUOUS` | A name matched several candidates (listed, enveloped) |
| `AB_LIMIT_QUERY` | The query exceeds a workspace or grant limit |
| `AB_LIMIT_RESPONSE_TOO_LARGE` | Upstream response above the byte cap |
| `AB_LIMIT_RATE` / `AB_LIMIT_QUOTA` | Our rate limit or quota |
| `AB_BUDGET_EXHAUSTED` | The per-call request budget ran out |
| `AB_AGILITY_AUTH` | Agility rejected the token (401: invalid, revoked or missing) |
| `AB_AGILITY_RATE_LIMITED` | Agility returned 429 (`retryAfterSeconds` included) |
| `AB_AGILITY_TIMEOUT` / `AB_AGILITY_UNAVAILABLE` | Timeout / 5xx or network failure |
| `AB_AGILITY_TLS` | The instance's certificate is not trusted (Workers: HTTP 526 or an opaque fetch error, L-160); the hint points to `AB_CA_FILE` on Node and to the Node/Docker deployment for private CAs |
| `AB_AGILITY_WRONG_INSTANCE` | Redirect, login page or non-Agility response: check the instance URL |
| `AB_AGILITY_ERROR` | Other unexpected Agility response (Agility's 400 `{error, exceptions}` body is never returned raw) |
| `AB_WRITE_APPROVAL_PENDING` | Approval requested out of band: open the returned link, approve, then repeat the call |
| `AB_WRITE_APPROVAL_UNAVAILABLE` | Approval required but neither elicitation nor the approval page is available to this client |
| `AB_WRITE_APPROVAL_DECLINED` | The user declined or did not answer |
| `AB_WRITE_CONFLICT` | The target changed between plan and apply |
| `AB_INTERNAL` | Unexpected exception (with a reference id) |

Adding a code is an additive change; renaming or removing one follows [Deprecations](#deprecations).

## Kinds and annotations

| `kind` | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|
| `read` | true | false | true | true |
| `write` | false | false | per tool | true |
| `destructive` | false | true | per tool | true |

Annotations are derived from `kind` by the registry, never written by hand. Non-read tools need an explicit
`allowNonRead` at registration and are absent unless every write layer enables them (ADR-0013).

## Costs

- Each tool declares `cost`: the worst-case number of Agility requests in one call, including retries, paging and
  resolution (L-114). The registry hides a tool whose cost exceeds the deployment's per-call budget (L-115).
- A cost test forces the worst case for every tool and asserts requests ≤ declared cost.
- Descriptions state the cost when it can reach 8 or more requests, and what happens when the budget runs out.

## Untrusted data

Every value that came from Agility (names, descriptions, comments, custom fields, status names, error texts) goes
through the output shaper. The probe test feeds every tool and every output path (summary, notes, candidates, errors,
structured content, composite sections) with poisoned strings: envelope look-alikes, instructions, HTML with scripts,
bidi controls and very long values (L-038).

## Catalogue size and `tools/list` budget

- Default catalogue ≤ 25 tools (now 20); every group and all writes < 40 (now 35) (L-155, D-05).
- Serialised `tools/list`: **≤ 40 KB for the default catalogue and ≤ 72 KB with every group** (P0-07 measured about
  1.6 KB per tool with rich schemas). P1-13's size test enforces both; a tool that would break them is redesigned, not
  exempted.
- Tool schemas are converted to JSON Schema once per process and registered with `fromJsonSchema`; building the
  per-request server must stay under 2 ms for the default catalogue (P0-07: 0.7 ms for 25 tools).
- No deferred-tool or tool-search mechanism while the catalogue stays under these limits (prior-art follow-up 1,
  revisited if it ever approaches 40).

## Lints

P1-13 builds these from the specifications here; each refused example is a test case.

**Naming lint** (tool names and argument names):

| Refused | Why | Use instead |
|---|---|---|
| `getWorkItem`, `GetWorkItem` | not `snake_case` | `get_work_item` |
| `work_item_get`, `stories` | verb first | `get_work_item`, `list_…` |
| `fetch_story`, `read_defects`, `do_query` | verbs outside the list above | `get_…`, `list_…`, `query_assets` |
| `query_assets_v2`, `get_work_item_new` | version or novelty suffixes | change the tool under Deprecations |
| arguments `id`, `oid`, `number` | one name per concept | `asset` |
| `scope`, `iteration`, `timebox`, `owner`, `assignee` | one name per concept | `project`, `sprint`, `member` |
| `page`, `page_size`, `pageSize`, `next_cursor`, `max_results` | one paging contract | `limit`, `cursor` |
| `since`, `until`, `window` | one time contract | `time_range`, `as_of` |
| `where`, `filter_expression`, `query`, `oql`, `raw` | no raw filters (ADR-0012) | `filters`, `any_of` |
| `start_h`, `effort_d` | unit abbreviations | `_hours`, `_days` |

**Secret-field lint** (registry refusal at startup, any depth of an input schema): names matching
`token|api[_-]?key|apikey|password|passwd|secret|authorization|cookie|session|credential|private[_-]?key`
(case-insensitive) are refused (L-070, THREAT_MODEL T23).

**Description lint:**

| Refused | Why |
|---|---|
| "This tool lists…", "Use this to…", "A tool that…" | start with the action |
| more than 450 characters | token budget |
| a list tool without "Paged: pass `nextCursor` back as `cursor`" or "Not paged: …" | paging must be explicit |
| a write tool without "Changes Agility. Needs approval." | side effects must be explicit |
| a tool with `cost ≥ 8` that does not state it | cost must be explicit |
| a typed default ("default 25") | defaults come from the schema (L-150) |
| instance-specific words (status names, custom fields, a customer's project) | `tools/list` is static per version (THREAT_MODEL A12) |

**Schema lint:** `type` arrays and `nullable` are refused in input and output schemas; output schemas are open
(`additionalProperties` not `false`); every list output has `nextCursor` or `truncated`, never both; scalar filter values
carry the no-comma rule; every `limit` has a maximum.

**Negative query fixtures** for the compiler (P1-04, P1-08): raw `where`/`sel`/`sort` strings in the style of earlier
Agility prototypes, WIQL/JQL-like expressions, and the P0-06 `with` cases (quotes, `|`, `;`, parentheses, commas) are
all refused or bound safely (prior-art follow-up 6).

## Client hints and operator limits

Request headers and arguments can **narrow** what the workspace and grant allow (fewer rows, fewer tools, a smaller
window), never widen it; any value above a configured limit is clamped and reported in `notes` (prior-art follow-up 4).

## Deprecations

- Before 1.0, renames are allowed with a changelog entry.
- From 1.0: keep the old name as an alias for at least one minor release and six months, prefix its description with
  `Deprecated:`, log one warning per process, and list it in the deprecation registry (tool arguments, output fields and
  environment variables alike), which `doctor` and the docs read (L-045). Aliases count against the catalogue budget
  only while their deprecation runs (prior-art follow-up 2).
