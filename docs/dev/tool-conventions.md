# Tool conventions

> Status: **draft** (2026-10-16), finalised in P0-11 and enforced from P1-13 by a naming lint, a description lint, a
> secret-field lint and a `tools/list` size test that run in `pnpm test`. A tool that breaks a rule fails the build: fix
> the tool, do not add an exception (L-030).

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
| Structured filters | `filters` | object[] | Generic tools only: `{ field, op, value }`, `op` ∈ `eq` `ne` `lt` `le` `gt` `ge` `contains` `in` `is_set` `is_not_set`. |
| Alternatives | `any_of` | object[][] | Generic tools only; OR between groups of filters, AND inside a group; limited count. |
| Time window | `time_range` | string | e.g. `"last 14 days"`, `"2026-10-01 to 2026-10-15"` (UTC; L-061). |
| Point in time | `as_of` | string | ISO 8601 UTC; bounded by the workspace's history limit. |
| Include closed items | `include_closed` | boolean | Default `false`. |
| Most rows | `limit` | integer | Rows of the main list. A cap on something else is `max_<things>`. |
| Next page | `cursor` | string | The `nextCursor` of the previous call with the same filters. A tool takes `cursor` only if it returns `nextCursor`. |
| Fewer fields per row | `minimal_output` | boolean | |
| Output format | `format` | enum | `auto` \| `table` \| `csv` \| `json`. |
| Order (typed tools) | `sort_by` | enum | Tool-specific values. |
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
additively (L-017).

| Concept | Name | Type | Notes |
|---|---|---|---|
| Asset number | `number` | string | |
| Asset type | `assetType` | string | API name. |
| OID token | `oid` | string | Without the moment suffix. |
| Name / title | `name` | string | Untrusted text. |
| Lifecycle | `state` | enum | `future` \| `active` \| `closed` \| `template` \| `broken_down` \| `deleted` \| `guest_collaborator` (members) \| `unknown`, from `AssetState`; `stateCode` carries the raw number. |
| Status | `status` | string \| null | The configured name. |
| Agility project | `project` | `{ oid, name }` | |
| Owners | `owners` | `{ oid, name, username, email? }[]` | `email` only when the workspace enables it. |
| Timestamps | `createdAt`, `changedAt`, `closedAt` | string | ISO 8601 UTC (L-149). |
| Effort | `estimate`, `detailEstimateHours`, `toDoHours`, `actualHours` | number \| null | `estimate` keeps the instance's estimate unit, reported once in `_meta`. |
| UI link | `url` | string | Built from the pinned instance origin (`assetdetail.v1`). |
| More pages | `nextCursor` | string \| null | Pass back as `cursor`. |
| Deliberately bounded list | `truncated` | boolean | Never `hasMore`, never together with `nextCursor`; the text says how to see the rest. |
| Matches reported by Agility | `total` | integer \| null | `null` when not computed (Agility's `-1`, L-144). |
| Rows dropped for being outside scope | `hiddenOutsideScope` | boolean | On every list that rechecks scope after fetching (L-064). |
| Not everything ran | `partial` + `notes` | boolean + string[] | Whenever paging, permissions, limits, budget or a failed section prevent a complete answer (L-033). |
| Window actually read | `since`, `until` | string | Resolved bounds, not the expression typed. |
| Write outcome | `applied`, `approval`, `plan` | | `approval`: `approved` \| `not_required` \| `dry_run`; see ADR-0013. |

Text output: a one-line summary, `Note:` lines, then the data block(s) in the requested `format`, each inside the
untrusted-data envelope ([ADR-0015](../adr/0015-tool-output-contract.md)).

## Paging

- Every list takes `limit` (default 25, maximum the workspace limit) and either pages or says why it is bounded.
- Agility paging is offset-based (`page {start, size}`); the tool always sends an explicit size (L-137) and a
  deterministic sort with a unique tiebreaker, and notes that concurrent edits can move items between pages.
- A cursor is client input, so it is never trusted for scope: `base64url(JSON)` carrying the offset, the first call's
  resolved window and a **binding** hash of tool + workspace + Agility projects + asset type + normalised filters + sort.
  A cursor from another tool, workspace or filter set, or a malformed one, is refused with `AB_INPUT_INVALID` before any
  request; offsets are range-checked; the window of the first call is kept (`time_range` is ignored once a cursor is
  passed, and descriptions say "keeps the first window").

## Errors

- Stable codes (`AB_*`, list in [ARCHITECTURE §7](../ARCHITECTURE.md#7-cross-cutting-concerns)); result
  `isError: true`, text `CODE: message`, optional `Hint:` line; `_meta["agility-bridge/error"] = { code, requestId }`.
- Messages are actionable for the agent and never contain secrets, tokens or raw Agility bodies; names and candidates
  inside an error are enveloped.
- Non-tool methods (prompts, resources) use JSON-RPC errors: `-32602` for invalid parameters, `-32603` with
  `data.code` for limits, budget, rate, quota and upstream failures (L-019).

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

## Deprecations

- Before 1.0, renames are allowed with a changelog entry.
- From 1.0: keep the old name as an alias for at least one minor release and six months, prefix its description with
  `Deprecated:`, log one warning per process, and list it in the deprecation registry (tool arguments, output fields and
  environment variables alike), which `doctor` and the docs read (L-045).
