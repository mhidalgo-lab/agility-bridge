# Tool conventions

> Status: **final** (P0-11, 2026-10-21, owner sign-off in [pending decisions](../pending-decisions/phase-0.md)), with
> the facts the Phase 0 spikes measured. Enforced by the naming, description, secret-field and schema lints
> (`packages/core/test/harness/lint.ts`, `lint.test.ts`) and the `tools/list` size and A12 tests (`contract.test.ts`)
> in `pnpm test`; the [tool reference](../reference/tools.md) is generated from the registry (`pnpm docs:tools`). A tool that breaks a rule fails the build: fix the
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
  `nextCursor` back as `cursor`" exactly when the tool takes `cursor`, otherwise "Not paged."), side effects for writes
  ("Changes Agility. Needs approval."), and the cost when a call can reach 8 or more Agility requests, in one sentence:
  "Cold call: up to N Agility requests." (N is the declared cost; below 8 the description says nothing about cost).
- Open with an imperative verb ("Get …", "List …", "Summarise …"), never "What …", "The …" or a third-person verb.
  Use the words a person would use ("comments", "files attached", "who is on", "which one is current"): the lexical
  router eval (`pnpm eval:router`) matches them, and a trim that drops them lowers its score (L-320).
- **Titles** are sentence case (proper names and acronyms such as Agility, UTC, OID keep their capitals), at most 40
  characters, no final punctuation, and a `list_` / `get_` / `search_` / `describe_` / `query_` tool's title starts with
  that verb ("List teams", "Get a sprint"); report titles are nouns ("Sprint health").
- Default values in descriptions and server instructions are generated from the schema, never typed by hand (L-150).
- Never put instructions about other content, secrets or examples with real data in descriptions.

## Arguments (input schema)

Arguments are `snake_case`. Prompt arguments use the same names.

**Shared names come from `packages/core/src/tools/common.ts` and nowhere else** (L-317): `assetArg`, `epicArg`,
`workItemArg`, `assetTypeArg`, `projectArg`, `teamArg`, `sprintArg` / `currentSprintArg`, `memberArg` / `myMemberArg`,
`statusArg`, `timeRangeArg(default)`, `workItemTypeArg(types)`, `includeClosedArg`, `minimalOutputArg`, `limitArg`,
`cursorArg`, `containsArg(what)` and `formatArg`. A tool uses the schema instead of re-describing the concept; the
description lint compares what `tools/list` advertises with `ARGUMENT_VOCABULARY` in the same file, and the type of every
shared name is checked too. A different concept gets its own vocabulary entry (a work-item `asset_type` enum versus a free
asset type name), never an exception. A tool with a natural default says so in the schema (`myMemberArg` defaults to `me`,
`currentSprintArg` to `current`).

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
| Most rows | `limit` | integer | Rows of the main list. A cap on something else is `max_<things>` (an integer). |
| Next page | `cursor` | string | The `nextCursor` of the previous call with the same filters. A tool takes `cursor` only if it returns `nextCursor`. |
| Fewer fields per row | `minimal_output` | boolean | Identity columns and name only. |
| Leave out related assets | `skip_related` | boolean | `get_work_item`: no children, links or comments. A different thing from `minimal_output`, so a different name (P6-45). |
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
| Timestamps | `createdAt`, `changedAt`, `closedAt` | string | ISO 8601 UTC (L-149). A plain date attribute a caller selects, filters or sorts by (`ChangeDate`) is read through its `…UTC` sibling and keeps the requested key (L-335); a date with no sibling is returned raw with a note that it is local time of an unknown zone. |
| Effort | `estimate`, `detailEstimateHours`, `toDoHours`, `actualHours` | number (optional) | Omitted when not set; `estimate` keeps the instance's estimate unit, reported once in `_meta`. |
| UI link | `url` | string | Added by the server to every asset row (`assetType` plus a valid `oid` or `number`), built from the pinned instance URL (`assetdetail.v1`, P8-02); a tool never builds one. |
| More pages | `nextCursor` | string (optional) | Present only when more rows exist (the tool fetches `limit + 1`); pass back as `cursor`. |
| Counts | `<thing>Count` | integer | `childCount`, `commentCount`, `itemCount`: never `items` (always the row array) or a bare `count` (D-115). |
| Deliberately bounded list | `truncated` | boolean | Never `hasMore`, never together with `nextCursor`; the text says how to see the rest. |
| Total matches | `total` | integer (optional) | Only when the tool actually computed it (e.g. an aggregate). Agility 26.0.3.2 returns no totals for lists (P0-06), so lists normally omit it and rely on `nextCursor`; never a guess or `-1` (L-144). |
| Rows dropped for being outside scope | `hiddenOutsideScope` | boolean | On every list that rechecks scope after fetching (L-064). |
| Not everything ran | `partial` + `notes` | boolean + string[] | Whenever paging, permissions, limits, budget or a failed section prevent a complete answer (L-033). |
| Window actually read | `window { since, until }` | object | Resolved UTC bounds, not the expression typed; a cursor keeps the first call's window. |
| Write outcome | `applied`, `approval`, `plan` | | `approval`: `approved` \| `not_required` \| `dry_run`; see ADR-0013. |

Rows start with the identity columns in one order, then the tool's own columns (L-043): `number`, `assetType`, `oid`,
`state`, `project` (those a row has), then `name`, `status`, … A list that is ordered or grouped by something (sprint,
change date) shows that column in the tool's own part, not before the identity. Every list output declares `partial` and
`notes` (a list that never sets them still says they exist) and every key the table above names keeps its type; a result
never returns a shared key its schema does not declare.

Text output: a one-line summary, `Note:` lines, then the data block(s) in the requested `format`, each inside the
untrusted-data envelope ([ADR-0015](../adr/0015-tool-output-contract.md)). Tools never format output themselves: they
call `shapeList` (paged or bounded lists) or `shapeOutput` (several sections) from `packages/core/src/output/`, and mark
Agility text in a summary or note with `untrusted(value)`, which moves that line inside the envelope. What agents see is
described in [Output formats](../guide/output-formats.md).

## Paging

- Every list takes `limit` (default 25, maximum the workspace limit) and either pages or says why it is bounded.
- A tool that takes `cursor` validates it **before anything that can return early** (an empty list, a missing project), so a
  forged or foreign cursor is always `AB_INPUT_INVALID` (L-318); a tool without `cursor` never returns `nextCursor`.
- Agility paging is offset-based (`page {start, size}`); the tool always sends an explicit size (L-137) and a
  deterministic sort ending with `ID` as the unique tiebreaker (pages measured disjoint and repeatable, P0-06), and
  notes that concurrent edits can move items between pages. Offsets count **upstream positions**: a row the scope recheck drops still
  advances the cursor, and a multi-type page merges each type's rows in upstream order (`runPage`, `multiPage`; L-170). "More available" comes from fetching `limit + 1` rows:
  Agility does not report totals (P0-06).
- A cursor is client input, so it is never trusted for scope: `base64url(JSON)` carrying the offset, the first call's
  resolved window and a **binding** hash of tool + workspace + Agility projects + asset type + normalised filters + sort.
  A cursor from another tool, workspace or filter set, or a malformed one, is refused with `AB_INPUT_INVALID` before any
  request; offsets are range-checked; the window of the first call is kept (`time_range` is ignored once a cursor is
  passed, and descriptions say "keeps the first window").
- A cursor can also carry **running totals** (`get_portfolio_tree`, P6-16): compact digits-and-separators text, a fingerprint
  of what they were taken over and a "cut for good" flag, all re-validated; until the last step the result is `partial`.
- The window and the first call's "now" (for lists filtered by time, such as `list_sprints` `timing`) are part of the
  binding (`bindFixed`), so an edited one is refused. The hash has no secret, so `decodeCursor` also re-validates them:
  the window must be ordered UTC instants no longer than `maxTimeRangeDays`, and "now" may be at most a day old
  (`CURSOR_MAX_AGE_MS`); after that the list starts again (L-172).

## Errors

- Stable codes (`AB_*`, the final list below); result `isError: true`, text `CODE: message`, optional `Hint:` line;
  `_meta["agility-bridge/error"] = { code, requestId }`.
- The same mistake gets the same code in every tool (the consistency test checks it): an unknown asset number, team,
  project, member or sprint is `AB_NOT_FOUND` (a project outside the workspace too: not found or not visible are the same
  answer, L-140); text that is not an asset number or OID token, a cursor that is not ours, a time range nobody understands
  and an unknown asset type name are `AB_INPUT_INVALID`; several close sprint, team or project names are `AB_AMBIGUOUS`
  with candidates. A value the input schema itself refuses (`limit: 0`, a value outside an enum, a missing or mistyped
  argument) is `AB_INPUT_INVALID` too, with the argument path and a `Hint:`; the server wrapper validates (the SDK's own
  check is a pass-through) and never echoes the value ([P6-37](../tasks/phase-6-tool-breadth/P6-37-consistency-schema-errors.md), D-153).
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
| `AB_AGILITY_ERROR` | Other unexpected Agility response. Agility's `{error, exceptions}` text is withheld from the result entirely (it goes to the server log, `agility refused the request`); the agent gets our message and a trusted next-step hint (P6-33, L-333) |
| `AB_WRITE_APPROVAL_PENDING` | Approval requested out of band: open the returned link, approve, then repeat the call |
| `AB_WRITE_APPROVAL_UNAVAILABLE` | Approval required but neither elicitation nor the approval page is available to this client |
| `AB_WRITE_APPROVAL_DECLINED` | The user declined or did not answer |
| `AB_WRITE_CONFLICT` | The target changed between plan and apply |
| `AB_WRITE_AUDIT_UNAVAILABLE` | The intent of a write could not be recorded, so nothing was changed (L-109) |
| `AB_WRITE_LIMIT_UNAVAILABLE` | The write limiter could not count (its store failed), so nothing was changed; writes fail closed (L-080) |
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
  resolution (L-114). The registry hides a tool whose cost exceeds the deployment's per-call budget (`select({ maxCost })`, L-115; see
  [core contracts](core.md)). The hidden tools are not silent (P6-36): the host sets `ctx.hiddenByBudget` from
  `registry.hiddenByBudget(...)` and `whoami` names them with their cost in a note and a `hiddenByBudget` field (only when
  non-empty; the output schema stays open, so `tools/list` does not grow). The admin panel shows the same note on a
  workspace or grant whose explicit `callBudget` is below the cost of a tool in its explicit list; a budget inherited from
  the server's default is not known to the panel (see P6-58).
- The small readers of Agility values (`num`, `text`, `round1`, `isAcceptanceAttribute`) live once in `tools/common.ts` (P6-45, L-317); a tool does not define its own.
- One test (`packages/core/test/tools/cost.test.ts`) walks `CORE_TOOLS` and measures each tool's worst-case call on a cold
  cache against its declared cost (L-313). **A new tool needs an entry in `test/tools/worst-case.ts`** (arguments of its most
  expensive call over the shared world, composites measured with their siblings), or the test fails; a fixture whose call
  errors or makes no request fails too. The deepest cases (four-level trees, every page) stay in the tool's own test file.
- The consistency checks also run on worlds where branches return early (`test/tools/consistency-worlds.test.ts`, P6-38):
  no rows, a workspace whose projects list nothing, a grant denying asset types, a grant without the report siblings. A
  paged tool refuses a bad cursor as `AB_INPUT_INVALID` first in all of them, with the full arguments and before any
  name is resolved or any request made: call `checkCursorShape(ctx, input.cursor)` (`query/cursor.ts`) at the top of the
  handler, since the binding itself needs resolved ids and is checked later by `decodeCursor` (L-318).
- A composite names the tools it reads in `COMPOSITE_SIBLINGS` (`tools/reports/siblings.ts`); a test ties the table to the
  sections it runs. `whoami` (`warnings`, a note) and the admin panel (workspace and grant pages, from `GET /tools`
  `siblings`) warn when a composite is granted without some of them (L-314). A composite never costs less than a sibling,
  so a per-call budget never hides a sibling and keeps the composite.
- Descriptions state the cost when it can reach 8 or more requests, and what happens when the budget runs out.

## Untrusted data

Every value that came from Agility (names, descriptions, comments, custom fields, status names, ambiguous-name candidates)
goes through the output shaper. Agility's own error messages are not shown at all: the first LLM eval showed models
following an instruction planted in error text even inside the envelope, so an error carries only our message, a trusted
hint that names a working next step, and enveloped candidates where the agent must choose (P6-33, L-333). The probe test feeds every tool and every output path (summary, notes, candidates, errors,
structured content, composite sections) with poisoned strings: envelope look-alikes, instructions, HTML with scripts,
bidi controls and very long values (L-038).

## Resources and prompts (manifest)

Resources (P6-09) and prompts (P6-08) are registered from one manifest, never from lists of their own (L-153):
`packages/core/src/manifest.ts` (`ManifestEntry`: a stable snake_case `id` and `uses`, the tools that serve the entry) and
`resources.ts` (`RESOURCE_MANIFEST`). An entry exists for a caller only when every tool in `uses` is allowed
(`availableEntries`); `buildMcpServer` does the filtering, so stdio and HTTP both get it with no host change.

- **Add a recipe resource** (P6-03, P6-06): one entry with `uri`, `title`, `description` (static, no instance words),
  `mimeType`, `source`, `uses` and `read`. A `read` that needs Agility calls `reader.run('<tool>', input)`: that runs the
  declared tool's handler with its schema, so budget, limits, cache, scope, envelope and audit are the tool's. A template
  URI (`{variable}`) also gives `list`, built from the same tool output the read uses, so every listed URI is readable.
- **Add a prompt** (P6-08): one entry in `PROMPT_MANIFEST` (`prompts.ts`), a sibling of the resource manifest filtered with the
  same `availableEntries`: `id`, `uses` (the tools its text tells the model to call; a test checks the text names exactly
  those), `title`, `description`, `arguments` (a zod object of string arguments named by the tool vocabulary, each described,
  validated like a tool's; use `text()` and `ref()`) and `build`. Arguments enter the text only through `given()` / `q()`
  (JSON-quoted) and never reach a query. Always end with `PROMPT_RULES` (untrusted data, read-only). A prompt calls no tool
  itself, so it has no budget or audit row. A prompt on an opt-in group is absent without it (D-105).
- Static text is our own; anything from Agility goes through the output shaper (the tool's, or `shapeOutput`) so it is
  enveloped. The poisoned-string probe and a "read every listed entry" test cover every entry; `pnpm docs:resources`
  regenerates [the resource reference](../reference/resources.md) and `pnpm docs:prompts` [the prompt reference](../reference/prompts.md).
- Reads are audited as `tool_call` rows whose action is `resource:<id>`.

## Catalogue size and `tools/list` budget

- Default catalogue ≤ 25 tools (now 21); every group and all writes < 40 (now 27 read tools + the 9 planned Phase 7
  write tools = 36) (L-155, D-05). The arithmetic is recorded in the [tool catalogue](../reference/tool-catalogue.md#counts-and-toolslist-size);
  the contract test fails when the count of tools with every group plus nine reaches 40.
- Serialised `tools/list`: **≤ 40 KB for the default catalogue and ≤ 72 KB with every group**, plus a tripwire for headroom:
  the default catalogue stays at **≤ 37.6 KB** (36.5 KB until `get_velocity`, D-140) and no single tool above **4,000 bytes** (D-116). Measured after the P6-12
  consistency pass: default 20 tools, **35,892 B** (21 tools and 37,498 B with `get_velocity`) (was 39,179); every group 26 tools, **44,157 B** (was 47,946); the five
  reports add 6,952 B and `get_attachment` 1,335 B. A tool that would break a limit is redesigned, not exempted.
- The default catalogue is every group a workspace gets without switching one on; the opt-in groups (`attachments`,
  `reports`, `writes`) count only against the every-group budget.
- Where the bytes go, in the order that paid off (L-320): structure first (the advertised output schema drops
  `additionalProperties: {}` since open is the default; the nested filter inside `any_of` carries no descriptions; one
  shared one-line description per shared argument), then description prose. Re-run `pnpm eval:router` after every trim and
  raise `scripts/evals/baseline.json` (`pnpm eval:router --write-baseline`) when a rewrite improves it.
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
| "Paged: …" without a `cursor` argument, a `cursor` argument without it, or neither "Paged" nor "Not paged" | paging must be explicit and true |
| a write tool without "Changes Agility. Needs approval." | side effects must be explicit |
| a tool with `cost ≥ 8` without "Cold call: up to N Agility requests", or a cheaper tool that mentions requests | one cost sentence |
| a first word that is not an imperative verb ("What changed …", "The …", "Lists …") | start with the action |
| a typed default ("default 25") | defaults come from the schema (L-150) |
| instance-specific words (status names, custom fields, a customer's project) | `tools/list` is static per version (THREAT_MODEL A12) |

**Title lint:** sentence case, at most 40 characters, no final punctuation, starts with the tool name's verb for verb
tools. **Argument lint:** shared names carry the shared type and description from `tools/common.ts` (`ARGUMENT_VOCABULARY`);
`format` is `auto | table | csv | json` defaulting to `auto`; `contains` is `containsArg(...)`; `max_*` is an integer;
`sort_by` is an enum whose default is `id`. **Output lint:** keys at every depth are camelCase; `items` is an array,
`partial` / `truncated` / `hiddenOutsideScope` booleans, `notes` an array of strings, `window` has `since` and `until`;
`hasMore`, `next_cursor`, `warnings`, `count` and the like are refused; every list declares `partial` and `notes`.

**Behavioural consistency test** (`packages/core/test/tools/consistency.test.ts`, P6-12): runs every tool's worst case and
checks identity columns first, every returned shared key declared with its type, `partial` explaining itself in `notes`,
`nextCursor` and `truncated` never together, one error code per mistake (list above), and one paging contract (the cursor
of page one opens page two, keeps the first window, and is refused with other filters).

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
- How a deprecated argument works (P6-45): the tool lists `deprecatedArguments: { old: 'new' }`; the server maps the old name
  to the new one before validating (the new name wins when both are given), adds a fixed `Note:` and a `notes` entry to the
  result, and logs one warning per process. The old name is **not** advertised (the input schema, `tools/list` and the
  argument lint stay as they are); `DEPRECATIONS` lists it with `since` and `removeIn`, and a consistency test ties the
  two. `get_work_item.minimal_output` (renamed `skip_related`) is the first, removed in 0.7.0.
