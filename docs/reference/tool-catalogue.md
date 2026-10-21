# Tool catalogue (planned)

> The shipped tools, with their exact arguments, defaults and costs, are in the generated
> [tool reference](tools.md); this page is the plan for every phase.

> Status: **groups and counts final** (P0-11, 2026-10-21); per-tool names, arguments and outputs follow the final
> [tool conventions](../dev/tool-conventions.md) and are frozen per tool when its task lands; P1-13 replaces this page's tables with the generated reference
> (`docs/reference/tools.md`). Costs are worst-case Agility requests per call *(estimates, finalised by the cost test)*.

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
| `attachments` | off (enable per workspace; `AB_ATTACHMENT_DOWNLOAD`) | `get_attachment` |
| `reports` | off (enable per workspace) | `sprint_health`, `standup_summary`, `release_readiness`, `defect_triage`, `work_item_quality` |
| `writes` | **off** | `add_comment`, `update_status`, `log_effort`, `assign_owners`, `move_to_sprint`, `create_work_item`, `update_fields`, `close_asset`, `reopen_asset` |

Default: 20 read tools (costs are worst cases with a cold metadata cache, verified by the cost tests). Everything: 26 read + 9 write = 35.

## Read tools

### Phase 1

| Tool | Group | Cost | What it does | Key arguments | Output highlights |
|---|---|---|---|---|---|
| `whoami` | core | 2 | Show the connection: instance and version, the member behind the token, workspace, allowed Agility projects and asset types, enabled groups, limits by unit, the per-call budget, and whether writes and which approval channel are available. | — | `member { oid, name, username }`, `instance { id, url, version }`, `workspace { id, name, groups }`, `projects`, `assetTypes`, `limits`, `budget { requestsPerCall, requestsUsed }`, `writes: { enabled, approval: elicitation \| page \| unavailable \| not_required }` |
| `list_projects` | core | 4 | List the Agility projects this workspace allows (with sub-projects when included), with parent, state and schedule, sorted by name. Paged. | `contains`, `include_closed`, `limit`, `cursor`, `format` | `items[] { assetType, oid, name, state, parent { oid, name }, schedule { oid, name } }`, `nextCursor` |
| `list_asset_types` | core | 24 | List the asset types this workspace allows on the instance, with base type, number prefix and scope strategy; types the workspace does not allow are not listed. The first call loads metadata per type (cached for an hour). | `contains`, `format` | `items[] { assetType, base, prefix, scopeStrategy, scopePath }` |
| `describe_asset_type` | core | 5 | Describe one asset type: attributes (type, relation target, multi-value, custom, read-only, required), operations, statuses, field tiers. | `asset_type`, `contains`, `format` | `assetType`, `base`, `abstract`, `scopeStrategy`, `attributes[]`, `operations[]`, `statuses[] { oid, name, category, inactive, team }`, `tiers { minimal, default, full }` |
| `query_assets` | query | 12 | Query any allowed asset type with structured filters, fields and sort; values are always bound, scope is enforced and every row rechecked. Global types only when the workspace's allow list names them. Paged. Each call is capped at its cost (cold metadata); a capped call succeeds when repeated. | `asset_type`, `fields`, `filters`, `any_of`, `project`, `include_child_projects`, `include_closed`, `sort`, `as_of`, `minimal_output`, `limit`, `cursor`, `format` | `items[]`: identity columns (`number`, `assetType`, `oid`, `state`, `project { oid, name }`) plus one key per requested attribute path (relations as OID tokens, dates in UTC, rich text as text); `nextCursor`; `hiddenOutsideScope`. Agility returns no totals. |
| `get_assets` | query | 16 | Get one or more assets of any allowed type by number (`B-01234`, `D-…`, `TK-…`, `AT-…`) or OID token with chosen fields: one query per asset type, plus one cross-type lookup for numbers with unknown prefixes. Not paged (at most 50). | `assets`, `fields`, `minimal_output`, `format` | `items[]` (as `query_assets`), `notFound[]` (not found, not visible, or outside the workspace) |
| `search_work_items` | work | 24 | Search backlog items, defects, tasks and tests (all four by default, in one request) by Agility project, team, sprint (`current`/`previous`/`next`), owner (`me`), status names from the instance, status category or name text. Paged (a cursor per type, nothing skipped). | `asset_type` (Story \| Defect \| Task \| Test), `project`, `team`, `sprint`, `member`, `status`, `status_category`, `contains`, `include_closed`, `sort_by` (`id` \| `name` \| `recently_changed`), `limit`, `cursor`, `format` | `items[] { number, assetType, oid, state, project, name, status, owners, sprint, team, estimate, detailEstimateHours, toDoHours, changedAt }` |
| `get_work_item` | work | 24 | One work item with description and acceptance criteria as text (the acceptance-criteria attribute is discovered from metadata), owners, status, sprint, parent and epic, child tasks and tests, links and comment count, in one batched request; children and links capped at 20 with `partial`. | `asset`, `minimal_output`, `format` | `item`, `children[]`, `links[]`, `commentCount` |
| `list_my_work` | work | 16 | Open work items owned by the token's member (or another member), ordered and grouped by sprint and status. Paged. | `member` (default `me`), `include_closed`, `limit`, `cursor`, `format` | `items[]`, `groups[] { sprint, status, items }`, `member` |
| `list_teams` | planning | 2 | List teams by name (teams are global: not tied to an Agility project). Paged. | `contains`, `limit`, `cursor`, `format` | `items[] { assetType, oid, name }` |
| `get_team` | planning | 20 | Team details: its own workflow statuses where the instance has them, its current sprint, and members **derived from assignments** (owners of open backlog items and defects with the team inside the workspace; Agility teams have no roster, P0-06; emails only if enabled). | `team`, `format` | `team`, `currentSprint`, `members[] { oid, name, openItems }`, `membersSource: assignments`, `statuses[]` |
| `list_sprints` | planning | 10 | List sprints of the workspace's Agility projects with UTC dates and timing (`past`/`current`/`future`), filtered by team, project or timing, newest first. Paged. | `team`, `project`, `timing`, `limit`, `cursor`, `format` | `items[] { assetType, oid, name, state, timing, beginDate, endDate, schedule }` |
| `list_members` | people | 6 | Find members by name among the members of the workspace's Agility projects (`Scope.Members`; all members without a project restriction). Paged. | `contains`, `limit`, `cursor`, `format` | `items[] { assetType, oid, name, username, state, email? }` (email only when the workspace enables it) |

### Phase 6

| Tool | Group | Cost | What it does |
|---|---|---|---|
| `get_sprint` | planning | 6 | Sprint summary: dates, committed vs done estimates, items by status category, carry-over, burndown points (bounded history). |
| `list_portfolio_items` | portfolio | 3 | Portfolio items (epics by category such as Feature or Initiative) with status and progress. Paged. |
| `get_portfolio_tree` | portfolio | 8 | An epic with its descendants (sub-epics, backlog items) and roll-ups (estimate, done %, open defects); depth-bounded. |
| `get_conversations` | collaboration | 3 | Comments on an asset, newest first. Paged. |
| `list_attachments` | collaboration | 2 | Attachment metadata (name, size, type, author, date) for an asset; content download is not offered by default (THREAT_MODEL A8). |
| `get_attachment` | attachments | 3 | Opt-in, off by default (D-08): the text content of one attachment of an asset in scope, within the size and content-type allowlists, inside the untrusted-data envelope; never rendered or executed (THREAT_MODEL A8). |
| `get_asset_history` | history | 4 | What changed on an asset over a bounded window (status, owners, estimate, sprint, …) from the authoritative history. |
| `list_recent_changes` | history | 4 | Assets changed recently in an Agility project or team (bounded window). Paged. |
| `sprint_health` | reports | 12 | Progress vs time, scope change, blocked or unowned or unestimated items, defects opened during the sprint; honest `partial`. |
| `standup_summary` | reports | 10 | What moved, finished, got blocked or was created for a team since a point in time. |
| `release_readiness` | reports | 12 | For a release, schedule or epic: open defects by priority, failing or missing tests, items not done. |
| `defect_triage` | reports | 8 | New or untriaged defects with missing fields, age and likely duplicates (by name similarity). |
| `work_item_quality` | reports | 10 | Check backlog items against the versioned quality rubric: description, acceptance criteria, estimate, tests, owner, parent. |

Reports skip any section whose underlying tool the caller was not granted, with a note (L-037), and are offered as
MCP Tasks to clients that support them (Phase 8).

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

Registered only when every tool they use is allowed. Arguments use the tool vocabulary.

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

Served through the same handlers, limits and audit as the tools; registered from one manifest (L-153).

| URI | Content |
|---|---|
| `agility-bridge://reference/filters` | Cheat sheet of the structured filter vocabulary with examples |
| `agility-bridge://instance/asset-types` | Asset types of the workspace's instance (snapshot) |
| `agility-bridge://instance/asset-types/{asset_type}` | Attributes, operations and statuses of one type |
| `agility-bridge://workspace/projects` | The Agility projects this workspace allows, as a tree |
| `agility-bridge://rubrics/backlog-item-quality` | The versioned quality rubric (JSON) used by `work_item_quality` |

## MCP Apps and Tasks (Phase 8)

- **Apps**: `ui://agility-bridge/sprint-burndown` and `ui://agility-bridge/status-distribution`, linked from
  `get_sprint` and `sprint_health`; strict CSP, no network access, data from `structuredContent`; text tables for
  clients without Apps.
- **Tasks**: reports and large `query_assets` exports run as MCP Tasks for clients that declare the extension; inline
  results or explicit continuation otherwise.
