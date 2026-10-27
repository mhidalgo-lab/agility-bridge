# Tool catalogue

> The shipped tools, with their exact arguments, defaults and costs, are in the generated
> [tool reference](tools.md); this page is the catalogue by group, what each tool is for, and the plan for what is not
> built yet (write tools, Apps, Tasks).

> Status: **Phases 1 to 6 built; consistency pass P6-12 done (2026-10-27).** Per-tool names, arguments and outputs follow the
> final [tool conventions](../dev/tool-conventions.md), which the lints and the consistency test enforce. Costs are
> worst-case Agility requests per call on a cold cache, measured by the cost test (L-313).

## Design rules for the catalogue

- **Any asset type the instance exposes is reachable from Phase 1** (within its scope strategy) through the generic
  `query_assets` / `get_assets` tools ([ADR-0012](../adr/0012-structured-query-no-raw-passthrough.md)); typed tools exist where a workflow deserves a
  friendlier, cheaper or safer shape.
- **Small default catalogue** (target ≤ 25 tools) organised in **groups** that a workspace enables or disables; with every
  group and all writes enabled the total stays under 40 (Cursor's cap; L-155).
- **Read-only by default**; write tools form their own group, absent unless enabled at every layer
  ([ADR-0013](../adr/0013-opt-in-writes-human-approval.md)).
- Every tool works inside the workspace's Agility projects and asset types; results outside scope are dropped and
  reported (`hiddenOutsideScope`).

## Groups

| Group | Default | Tools |
|---|---|---|
| `core` | on | `whoami`, `list_projects`, `list_asset_types`, `describe_asset_type` |
| `query` | on (workspace switch `AB_GENERIC_QUERY`) | `query_assets`, `get_assets` |
| `work` | on | `search_work_items`, `get_work_item`, `list_my_work` |
| `planning` | on | `list_teams`, `get_team`, `list_sprints`, `get_sprint` |
| `people` | on | `list_members` |
| `portfolio` | on | `list_portfolio_items`, `get_portfolio_tree` |
| `collaboration` | on | `get_conversations`, `list_attachments` |
| `history` | on | `get_asset_history`, `list_recent_changes` |
| `attachments` | **off** (workspace limit `attachmentDownload`, which a grant can only turn off; `AB_ATTACHMENT_DOWNLOAD` in stdio) | `get_attachment` |
| `reports` | **off** (workspace limit `reports`, which a grant can only turn off; `AB_REPORTS` in stdio) | `sprint_health`, `standup_summary`, `release_readiness`, `defect_triage`, `work_item_quality` |
| `writes` | **off** | `add_comment`, `update_status`, `log_effort`, `assign_owners`, `move_to_sprint`, `create_work_item`, `update_fields`, `close_asset`, `reopen_asset` |

### Counts and `tools/list` size

Measured by the contract test (`packages/core/test/contract.test.ts`) on the registry as `tools/list` serialises it
(name, title, description, input and output schema, annotations), after the P6-12 consistency pass.

| Catalogue | Tools | `tools/list` bytes | Budget | Before P6-12 |
|---|---|---|---|---|
| Default (no opt-in group): `core` 4, `query` 2, `work` 3, `planning` 4, `people` 1, `portfolio` 2, `collaboration` 2, `history` 2 | 20 | **35,892** | 40,000 (test target 36,500) | 39,179 |
| `attachments` (opt-in) | +1 | +1,335 | | |
| `reports` (opt-in) | +5 | +6,952 | | |
| Every read group | 26 | **44,157** | 72,000 | 47,946 |
| Every read group + the nine Phase 7 write tools | 35 | about 60,000 (estimate: about 1.8 KB per write tool; measured when Phase 7 lands) | 72,000 | |

Tool count with everything on: 20 default + 1 attachments + 5 reports = 26 read tools, plus the 9 planned write tools
(`add_comment`, `update_status`, `log_effort`, `assign_owners`, `move_to_sprint`, `create_work_item`, `update_fields`,
`close_asset`, `reopen_asset`) = **35, five below the cap of 40** (L-155). The largest entry is `query_assets` (3.8 KB, the
generic tool with filters and sort); a test caps one tool at 4,000 bytes and the default catalogue at 36,500, so a tool
that does not fit is redesigned or pays for it in the same PR (D-116).

## Read tools

### Phase 1

| Tool | Group | Cost | What it does | Key arguments | Output highlights |
|---|---|---|---|---|---|
| `whoami` | core | 2 | Show the connection: instance and version, the member behind the token, workspace, allowed Agility projects and asset types, enabled groups, limits by unit, the per-call budget, and whether writes and which approval channel are available. | — | `member { oid, name, username }`, `instance { id, url, version }`, `workspace { id, name, groups }`, `projects`, `assetTypes`, `limits`, `budget { requestsPerCall, requestsUsed }`, `writes: { enabled, approval: elicitation \| page \| unavailable \| not_required }` |
| `list_projects` | core | 5 | List the Agility projects this workspace allows (with sub-projects when included), with parent, state and schedule, sorted by name. Paged. | `contains`, `include_closed`, `limit`, `cursor`, `format` | `items[] { assetType, oid, name, state, parent { oid, name }, schedule { oid, name } }`, `nextCursor` |
| `list_asset_types` | core | 24 | List the asset types this workspace allows on the instance, with base type, number prefix and scope strategy; types the workspace does not allow are not listed. The first call loads metadata per type (cached for an hour). | `contains`, `format` | `items[] { assetType, base, prefix, scopeStrategy, scopePath }` |
| `describe_asset_type` | core | 5 | Describe one asset type: attributes (type, relation target, multi-value, custom, read-only, required), operations, statuses, field tiers. | `asset_type`, `contains`, `format` | `assetType`, `base`, `abstract`, `scopeStrategy`, `attributes[]`, `operations[]`, `statuses[] { oid, name, category, inactive, team }`, `tiers { minimal, default, full }` |
| `query_assets` | query | 12 | Query any allowed asset type with structured filters, fields and sort; values are always bound, scope is enforced and every row rechecked. Global types only when the workspace's allow list names them. Paged. Each call is capped at its cost (cold metadata); a capped call succeeds when repeated. | `asset_type`, `fields`, `filters`, `any_of`, `project`, `include_child_projects`, `include_closed`, `sort`, `as_of`, `minimal_output`, `limit`, `cursor`, `format` | `items[]`: identity columns (`number`, `assetType`, `oid`, `state`, `project { oid, name }`) plus one key per requested attribute path (relations as OID tokens, dates in UTC, rich text as text); `nextCursor`; `hiddenOutsideScope`. Agility returns no totals. |
| `get_assets` | query | 16 | Get one or more assets of any allowed type by number (`B-01234`, `D-…`, `TK-…`, `AT-…`) or OID token with chosen fields: one query per asset type, plus one cross-type lookup for numbers with unknown prefixes. Not paged (at most 50). | `assets`, `fields`, `minimal_output`, `format` | `items[]` (as `query_assets`), `notFound[]` (not found, not visible, or outside the workspace) |
| `search_work_items` | work | 24 | Search backlog items, defects, tasks and tests (all four by default, in one request) by Agility project, team, sprint (`current`/`previous`/`next`), owner (`me`), status names from the instance, status category or name text. Paged (a cursor per type, nothing skipped). | `asset_type` (Story \| Defect \| Task \| Test), `project`, `team`, `sprint`, `member`, `status`, `status_category`, `contains`, `include_closed`, `sort_by` (`id` \| `name` \| `recently_changed` \| `oldest_changed`), `limit`, `cursor`, `format` | `items[] { number, assetType, oid, state, project, name, status, owners, sprint, team, estimate, detailEstimateHours, toDoHours, changedAt }` |
| `get_work_item` | work | 24 | One work item with description and acceptance criteria as text (the acceptance-criteria attribute is discovered from metadata), owners, status, sprint, parent and epic, child tasks and tests, links and comment count, in one batched request; children and links capped at 20 with `partial`. | `asset`, `minimal_output`, `format` | `item`, `children[]`, `links[]`, `commentCount` |
| `list_my_work` | work | 20 | Open work items owned by the token's member (or another member), ordered and grouped by sprint and status. Paged. | `member` (default `me`), `include_closed`, `limit`, `cursor`, `format` | `items[]`, `groups[] { sprint, status, items }`, `member` |
| `list_teams` | planning | 2 | List teams by name (teams are global: not tied to an Agility project). Paged. | `contains`, `limit`, `cursor`, `format` | `items[] { assetType, oid, name }` |
| `get_team` | planning | 20 | Team details: its own workflow statuses where the instance has them, its current sprint, and members **derived from assignments** (owners of open backlog items and defects with the team inside the workspace; Agility teams have no roster, P0-06; emails only if enabled). | `team`, `format` | `team`, `currentSprint`, `members[] { oid, name, openItems }`, `membersSource: assignments`, `statuses[]` |
| `list_sprints` | planning | 10 | List sprints of the workspace's Agility projects with UTC dates and timing (`past`/`current`/`future`), filtered by team, project or timing, newest first. Paged. | `team`, `project`, `timing`, `limit`, `cursor`, `format` | `items[] { assetType, oid, name, state, timing, beginDate, endDate, schedule }` |
| `list_members` | people | 6 | Find members by name among the members of the workspace's Agility projects (`Scope.Members`; all members without a project restriction). Paged. | `contains`, `limit`, `cursor`, `format` | `items[] { assetType, oid, name, username, state, email? }` (email only when the workspace enables it) |

### Phase 6

| Tool | Group | Cost | What it does | Key arguments | Output highlights |
|---|---|---|---|---|---|
| `get_sprint` | planning | 30 | One sprint: UTC dates and schedule, backlog items and defects by status category (the instance's rollup categories) with estimates, **committed** at the begin date vs done, scope change, **carry-over** of a finished sprint (read as it ended) and a daily **burndown** from bounded `asof` history (at most 15 points, 20 queries per request, `maxAsOfAgeDays`). Missing estimates, categories or history are reported in `notes`, never as zeros; capacity is not reported (D-83). Not paged. | `sprint` (default `current`), `team`, `project`, `burndown`, `format` | `sprint { oid, name, state, timing, beginDate, endDate, schedule }`, `basis`, `totals { itemCount, estimate?, done?, remaining?, unestimatedItems }`, `byStatusCategory[] { category, itemCount, estimate?, unestimatedItems }`, `committed?`, `planned?`, `scopeChange?`, `carryOver?`, `burndown[] { at, remaining?, ideal?, itemCount }`, `items[]`, `truncated?` (counts are `<thing>Count`, D-115) |
| `list_portfolio_items` | portfolio | 12 | Portfolio items (epics; Feature, Initiative and the like are values of the epic's category) of the workspace's Agility projects with status, parent, estimates and the number of live children; filter by category, Agility project, status, parent epic or name. Paged. | `category`, `project`, `status`, `parent`, `contains`, `include_closed`, `sort_by` (`id` \| `name`), `limit`, `cursor`, `format` | `items[] { number, assetType, oid, state, project, category, name, status, parent, childCount }` |
| `get_portfolio_tree` | portfolio | 20 | An epic with its descendant epics (`depth` 1 to 4) and roll-ups per epic over the stories and defects below it: items, done, open defects, estimate, done %. A depth, size, budget or permission cut is `partial` and marks the roll-ups it touches `incomplete`. Not paged. | `asset` (epic), `depth`, `include_items`, `max_items`, `format` | `root`, `nodes[]`, `backlogItems[]?`, `partial?`, `notes?` |
| `get_conversations` | collaboration | 10 | Comments on one asset in scope, newest first, with author, date and text (rich text as text). Paged. | `asset`, `limit`, `cursor`, `format` | `items[] { oid, authoredAt, author, conversation, content }` |
| `list_attachments` | collaboration | 12 | Attachment metadata (name, file name, type, author, date; size where the instance has it) for one asset in scope, and on the first page its external links as text (never fetched). Paged. No content is returned or fetched. | `asset`, `limit`, `cursor`, `format` | `items[] { oid, name, filename, contentType, bytes, author, createdAt, description }`, `links[]` |
| `get_attachment` | attachments | 12 | Opt-in, off by default (D-08): the text of one attachment of an asset in scope, within the size and content-type allowlists, inside the untrusted-data envelope; never rendered or executed (THREAT_MODEL A8). Not paged: text is cut at `max_characters` (P6-20 adds ranged reads). | `asset`, `attachment`, `max_characters` | `attachment { oid, name?, contentType, bytes, characters }`, `asset`, `truncated` (the text is in the enveloped block only) |
| `get_asset_history` | history | 14 | What changed on one asset in a bounded window (`time_range`, at most the workspace maximum), from the authoritative `rest-1.v1/Hist` versions: one row per changed field, newest first, diffed against the version before the window. `fields` (at most 10 plain attribute paths, validated by the query compiler; paths reaching project-bound assets, and `Scope`, are refused) or a default set. A window may not start earlier than the workspace `maxAsOfAgeDays`. Not paged: `limit` caps the rows, `truncated` says more exist. The activity stream is never read (D-89). | `asset`, `time_range`, `fields`, `limit`, `format` | `items[] { changedAt, changedBy, field, from, to, version }`, `asset`, `window { since, until }`, `versions { total, inWindow }`, `truncated?`, `partial?`, `notes?` |
| `list_recent_changes` | history | 24 | Work items (Story, Defect, Task, Test) and epics (portfolio items, D-91) changed inside a bounded `time_range` in an Agility project, a team or the whole workspace, newest change first, with who changed them; sorting by change date costs about a second. Paged (a cursor per type). Says which items changed; `get_asset_history` says what changed. | `project`, `team`, `asset_type`, `time_range`, `include_closed`, `limit`, `cursor`, `format` | `items[]`: identity columns, `name`, `category` (epics), `status`, `owners`, `sprint`, `changedAt`, `changedBy`; `window { since, until }` |
| `sprint_health` | reports | 54 | `get_sprint` plus the sprint's open items: share done against share of time elapsed (a status `on_track` / `at_risk` / `off_track` only for a current sprint with a known share), scope added after the start, unestimated items, open defects, open items without an owner or unchanged for 3 days. Honest `partial`. | `sprint` (default `current`), `team`, `project` | `sections[]`, `sprint`, `pace`, `partial`, `notes` |
| `standup_summary` | reports | 48 | For a member (default `me`), optionally within a team or project and a `time_range`: items finished, items changed, items in progress (two `search_work_items` reads). Blockers are not reported (no blocked flag is read) and the result says so. | `member`, `team`, `project`, `time_range` | `sections[]`, `window { since, until }`, `partial`, `notes` |
| `release_readiness` | reports | 20 | For an epic (release or initiative): open items, open defects, unestimated open items and sub-epics short of done, from `get_portfolio_tree`. Verdict `ready` only when everything was read and nothing is open, `not_ready` when open work was seen, otherwise `unknown`. Tests are not read. | `asset` (epic), `depth` | `sections[]`, `verdict`, `epic`, `partial`, `notes` |
| `defect_triage` | reports | 24 | Open defects of a project, team or sprint (first page, at most 100): no owner, no sprint, unchanged for 14 days, and likely duplicates by name similarity. Priority and severity are not read yet (P6-30). | `project`, `team`, `sprint` | `sections[]`, `counts`, `partial`, `notes` |
| `work_item_quality` | reports | 28 | One backlog item or defect scored with the versioned rubric (`agility-bridge://rubrics/backlog-item-quality`, cited by version): mechanical checks with the evidence per criterion, `null` for what could not be assessed, a score range and a level only when the range stays in one. Dependencies are not read. | `asset` | `sections[]`, `rubric`, `criteria[]`, `score`, `scoreMin`, `scoreMax`, `level`, `partial`, `notes` |

Reports skip any section whose underlying tool the caller was not granted, with a note (L-037), and are offered as
MCP Tasks to clients that support them (Phase 8). The `reports` group is absent from `tools/list` and refused by name
unless the workspace limit `reports` is on and the grant keeps it on (stdio: `AB_REPORTS=on`, or `reports: true` in the
workspace). A report's declared cost is the sum of its sections' costs (L-302); a section that is skipped, failed, out of
budget or cut is named in `sections` and in the notes, and what it would have contributed is absent, never zero (L-033).
Calls to the siblings use the same context, scope and budget: a composite never widens what the caller may read.

### Attachments (opt-in)

`get_attachment` is absent from `tools/list` and refused by name unless the workspace limit `attachmentDownload` is on and
the grant keeps it on (a grant can only turn it off, and only lower `attachmentMaxBytes`; stdio: `AB_ATTACHMENT_DOWNLOAD`,
`AB_ATTACHMENT_MAX_BYTES`, `AB_ATTACHMENT_TYPES`). Checks, in order: the asset is in scope (resolver, project predicate,
row recheck); the attachment row is the one asked for and belongs to that asset; its stored content type is on the
allowlist (default `text/plain`, `text/markdown`, `text/csv`, `application/json`; HTML, SVG, XML and JavaScript never);
then one content request whose response type is checked again and whose body is cut at the size cap on the stream; the
text must be valid UTF-8 without NUL. The call spends from the budget and is audited (asset number, attachment id,
size, type). See [THREAT_MODEL](../THREAT_MODEL.md) A8 and D-86 … D-88.

## Write tools (Phase 7, opt-in)

All write tools take `dry_run` and `confirm`, need approval by default, act on **one** asset, re-check the target before
applying, are never retried, and note that Agility may take a moment to show the change
([ADR-0013](../adr/0013-opt-in-writes-human-approval.md)).

| Tool | Kind | What it changes |
|---|---|---|
| `add_comment` | write | Adds a comment to an asset's conversation. |
| `update_status` | write | Sets the status of a work item to one configured for its type (and team process). |
| `log_effort` | write | Logs actual hours on a task or work item and optionally updates the remaining to-do. |
| `assign_owners` | write | Adds or removes owners of a work item. |
| `move_to_sprint` | write | Moves a work item to a sprint or back to the backlog. |
| `create_work_item` | write | Creates a backlog item, defect, task (under a parent) or test, with an allowlisted set of fields per type. |
| `update_fields` | write | Updates allowlisted fields (name, description, estimate, priority, and custom fields the workspace enables). |
| `close_asset` | destructive | Closes (or quick-closes) a work item. |
| `reopen_asset` | destructive | Reopens (reactivates) a closed work item. |

Never offered in 1.0: deleting assets, multi-asset or filter-based updates, conversions (e.g. backlog item to epic),
attachment upload, membership or permission changes.

## Prompts (Phase 6)

Registered only when every tool they use is allowed (so the three on report tools need the opt-in `reports` group, D-105).
Arguments use the tool vocabulary. Built in P6-08; the generated [prompt reference](prompts.md) is the current list.

| Prompt | Purpose | Uses |
|---|---|---|
| `review_backlog_item_quality` | Assess backlog items (one, a sprint or a team's backlog) against the versioned rubric and propose improvements | `work_item_quality`, `get_work_item` |
| `sprint_review` | Summarise a sprint for a review or demo | `get_sprint`, `search_work_items` |
| `standup` | Prepare a team's daily stand-up notes | `standup_summary` |
| `triage_defects` | Walk through new defects and propose priorities and owners | `defect_triage`, `get_work_item` |
| `draft_release_notes` | Draft release notes from items done in a sprint, release or epic | `search_work_items`, `get_portfolio_tree` |
| `refine_backlog` | Suggest splits and acceptance criteria for the top of a backlog (suggestions only) | `search_work_items`, `get_work_item` |
| `explain_asset` | Explain an asset in context: parents, children, history, conversation | `get_work_item`, `get_asset_history`, `get_conversations` |

## Resources (Phase 6)

Served through the same handlers, limits and audit as the tools; registered from one manifest (L-153). Built in P6-09; the
generated [resource reference](resources.md) is the current list. A resource is offered only when the tools it is served
through are allowed. Recipe resources: tests, defects and regression assets (P6-03), and issues, requests, goals and
themes, and retrospectives (P6-06), below.

| URI | Content |
|---|---|
| `agility-bridge://reference/filters` | Cheat sheet of the structured filter vocabulary with examples |
| `agility-bridge://instance/asset-types` | Asset types of the workspace's instance (snapshot) |
| `agility-bridge://instance/asset-types/{asset_type}` | Attributes, operations and statuses of one type |
| `agility-bridge://workspace/projects` | The Agility projects this workspace allows, as a tree |
| `agility-bridge://rubrics/backlog-item-quality` | The versioned quality rubric (JSON) used by `work_item_quality` |
| `agility-bridge://recipes/tests-and-defects` | Worked `query_assets` calls: tests of a backlog item, failing and never-run tests, open, unowned, by-priority, recently closed and per-sprint defects |
| `agility-bridge://recipes/regression-assets` | Worked `query_assets` calls: regression tests, test sets and the tests inside one; plans and suites by the same pattern after `list_asset_types` |
| `agility-bridge://recipes/issues`, `recipes/requests`, `recipes/goals-and-themes`, `recipes/retrospectives` | What the type is for, its default fields and example `query_assets` / `get_assets` inputs (P6-06; no typed tools, D-98) |

**Decision (P6-03, D-95): no typed quality tool.** Tests, regression tests/plans/suites, test sets and defects are answered by
the two recipes through `query_assets` (and `search_work_items` for a mixed list). Every case is a single filter, so a typed
tool would only rename it and spend a slot of the 40-tool budget (L-155, L-294). The recipes are offered only when
`query_assets`, `describe_asset_type` and `list_asset_types` are allowed, every example is compiled against the metadata
snapshot in CI, and the examples were run against the read-only tenant (tests and defects present; regression assets
absent there). Regression plans and suites have no validated example yet
([P6-25](../tasks/phase-6-tool-breadth/P6-25-verify-regression-recipes-sandbox.md)). The typed tool is revisited in
[P6-26](../tasks/phase-6-tool-breadth/P6-26-quality-typed-tool-revisit.md) if the tool evals say so.

## MCP Apps and Tasks (Phase 8)

- **Apps**: `ui://agility-bridge/sprint-burndown` and `ui://agility-bridge/status-distribution`, linked from
  `get_sprint` and `sprint_health`; strict CSP, no network access, data from `structuredContent`; text tables for
  clients without Apps.
- **Tasks**: reports and large `query_assets` exports run as MCP Tasks for clients that declare the extension; inline
  results or explicit continuation otherwise.
