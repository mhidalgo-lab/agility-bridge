# Pending decisions — Phase 6

> Open questions and owner steps from Phase 6. Answer inline (`**Owner:** …` with a date).

> The owner authorised the whole phase as a batch (2026-10-27): decisions marked *built as …* are implemented at their
> recommendation; say so if you want the alternative.

## Owner steps

Left for the owner after the Phase 6 review ([P6-13](../reviews/phase-6-review.md)); none needs a code change first.

1. **The OAuth client runs** ([P6-14](../tasks/phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md)) against the real deployment:
   Claude mobile, Claude Desktop connectors, VS Code, JetBrains, Copilot CLI and MCP Inspector (Cursor and Windsurf when a subscription
   exists), plus the Phase 5 follow-ups (disconnect and reconnect, a refresh of claude.ai, a real phone). The release gate needs
   them; record version and date in the [client matrix](../reference/client-compatibility.md#oauth-runs-p5-06).
2. **The first LLM eval run** ([P6-33](../tasks/phase-6-tool-breadth/P6-33-first-llm-eval-run.md)) before the release: it calls a paid
   API (`ANTHROPIC_API_KEY`, `pnpm eval:llm --yes`), with the default model and the strongest one (D-110). Attach the report; tune
   descriptions only from it (P6-34).
3. **The v0.6 release**: merge the Version Packages PR when 1 and 2 are done (the owner merges it; the release run publishes to npm
   and pushes the image).
4. **The writable sandbox** ([P6-19](../tasks/phase-6-tool-breadth/P6-19-verify-attachment-download.md),
   [P6-21](../tasks/phase-6-tool-breadth/P6-21-history-sandbox-verification.md),
   [P6-25](../tasks/phase-6-tool-breadth/P6-25-verify-regression-recipes-sandbox.md),
   [P6-27](../tasks/phase-6-tool-breadth/P6-27-verify-requests-on-sandbox.md)) is still the unblocker for the attachment download, the
   activity stream, the regression recipes and the requests: nothing in Phase 6 can verify them on the read-only tenant.
5. **The open decisions below, D-80 to D-122.** **Decided 2026-10-27:** every one as recommended except D-91, where the owner
   chose (b) (epics in `list_recent_changes` now, P6-22 brought forward). D-117 to D-122 come from the review: attachment text only in the enveloped block (D-117),
   a roll-up percentage by estimate only when every item has one (D-118), defect triage reading the oldest change first (D-119),
   no `Scope` in history (D-120), `resources/list` with no upstream call (D-121) and stdio serving the `history` group (D-122).

## Open decisions

### D-89 — The activity stream is not read by the history tools *(P6-05)*
- **Context:** ADR-0011 and L-146 say the activity stream is "only a hint": it may not contain every change. It is also
  outside the live-test guard (only `rest-1.v1` `Data` and `Hist`, `meta.v1` and `query.v1` are allowed), so any code
  against it would ship unverified, and RESEARCH records it as never probed.
- **Options:** (a) do not read it; `get_asset_history` and `list_recent_changes` use `Hist` and `query.v1` only and say
  their source; (b) add an optional, clearly labelled `activity_hint` section later, after the endpoint is probed on the
  writable sandbox; (c) read it now, unverified.
- **Recommendation:** (a), built. (b) is task [P6-21](../tasks/phase-6-tool-breadth/P6-21-history-sandbox-verification.md),
  after the sandbox exists.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-90 — `get_asset_history` is not paged; its window and row cap are the bound *(P6-05)*
- **Context:** `rest-1.v1/Hist/<type>/<id>` answers every version of the asset in one response; it cannot be narrowed by
  date on the request (not verified whether it accepts a `where` on `ChangeDate`, see RESEARCH §1.4). The tool therefore
  fetches once (response bytes are capped by the client), diffs, applies the window and returns at most `limit` rows
  (default: the workspace page size), newest first, with `truncated` when more exist. `time_range` defaults to the last
  30 days and may not exceed `maxTimeRangeDays`; `list_recent_changes` defaults to 7 days.
- **Options:** (a) as built: one request, row cap, no cursor; (b) a cursor over the diff rows (a second call repeats the
  whole `Hist` request, so it costs the same again for each page); (c) refuse assets with more than N versions.
- **Recommendation:** (a). A person asks about a window, not for page 7 of a version list; a window and a field list
  narrow the answer, and (b) adds a request per page for no new information.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-91 — `list_recent_changes` covers the four work-item types, not portfolio items *(P6-05)*
- **Context:** the tool queries Story, Defect, Task and Test through the same filters and merge as `search_work_items`
  (one batched `query.v1`, per-type cursors). Epics and other portfolio items live under their own scope strategy and
  belong with the portfolio tools ([P6-01](../tasks/phase-6-tool-breadth/P6-01-tools-portfolio.md)). `get_asset_history`
  works on any readable asset type, epics included.
- **Options:** (a) four work-item types now; portfolio items later; (b) add `Epic` now.
- **Recommendation:** (a), with [P6-22](../tasks/phase-6-tool-breadth/P6-22-recent-changes-portfolio-items.md) adding epics
  once P6-01 settles how portfolio items are listed.
- **Owner (2026-10-27):** Decided: (b), add epics now (deviates from the recommendation); [P6-22](../tasks/phase-6-tool-breadth/P6-22-recent-changes-portfolio-items.md) is brought forward. Built in P6-22 (`Epic` is a value of `asset_type`); live check pending.

### D-86 — Where the attachment download is switched on *(P6-04)*
- **Context:** D-08 wants `get_attachment` off by default and enabled "per workspace and grant". The access resolver
  lists every read tool of a workspace unless its tool list says otherwise, so an opt-in read tool needs a gate that
  does not depend on someone remembering to leave it out of a list.
- **Options:** (a) a workspace limit `attachmentDownload` (default off) that a grant can only turn off, like
  `genericQuery`, plus `attachmentMaxBytes` that a grant can only lower; the resolver drops the `attachments` group when
  it is off, and the handler refuses as well; stdio uses `AB_ATTACHMENT_DOWNLOAD` and friends; (b) a deployment-wide
  switch only; (c) tool lists only (name the tool in the workspace and the grant).
- **Recommendation:** (a): the same shape as every other switch (L-062: a grant can only tighten), visible in the admin
  limits form, and a tool named in a list is still not served while the switch is off.
- **Built:** (a). `AB_ATTACHMENT_DOWNLOAD` is not a deployment default for HTTP: the default is off and a workspace
  turns it on.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-87 — What counts as an attachment that may be returned *(P6-04)*
- **Context:** the task allows text types, checked on the metadata and on the response. Agility may serve a different
  type than it stored, an attachment may have no content type, and a deployment may want more types.
- **Options:** (a) exact `type/subtype` allowlist (default `text/plain`, `text/markdown`, `text/csv`,
  `application/json`; `AB_ATTACHMENT_TYPES` replaces it), types that run or render (`text/html`, `image/svg+xml`,
  XML, JavaScript) refused even when listed, a missing content type refused, text must be valid UTF-8 without NUL;
  (b) allow wildcards such as `text/*`; (c) sniff the bytes instead of trusting types.
- **Recommendation:** (a): the allowlist is what an operator can reason about, wildcards would admit HTML, and sniffing
  adds a parser to a path that fetches untrusted bytes.
- **Built:** (a). Unverified until a sandbox run (P6-19): the exact endpoint spelling (`attachments.img`, from the
  developer library) and whether Agility answers with the stored content type.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-88 — How much text one call returns *(P6-04)*
- **Context:** the download cap (1 MiB by default) bounds what the bridge reads, but a model's context should not take
  a megabyte of text in one result, and the output shaper caps one value at 4,000 characters.
- **Options:** (a) return up to `max_characters` (default 20,000, at most 100,000) in one enveloped text block, with a
  note and `truncated` when cut; ranged reads later (P6-20); (b) page through the text with a cursor now; (c) return
  the whole text up to the byte cap.
- **Recommendation:** (a): bounded results by default, and the common case (a log excerpt, a small CSV, a note) fits.
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-92 — The quality rubric is defined in core now, ahead of `work_item_quality` *(P6-09)*
- **Context:** the catalogue lists `agility-bridge://rubrics/backlog-item-quality` as "the versioned quality rubric (JSON)
  used by `work_item_quality`", but P6-07 (that tool) is not built yet.
- **Options:** (a) define the rubric in core now (`packages/core/src/rubric.ts`, version `1.0.0`) and serve it; P6-07 and the
  `review_backlog_item_quality` prompt import the same object; (b) defer the resource until P6-07.
- **Recommendation:** (a): one rubric for the resource, the tool and the prompt cannot drift, and the version is fixed from the
  first release. The criteria and weights are a starting point for the owner to tune; any change bumps `version`.
- **Built:** (a). The rubric resource is offered when `get_work_item` is allowed; P6-07 should add `work_item_quality` to its
  `uses` when it lands.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-93 — Static resources are offered only with the tool they describe *(P6-09)*
- **Context:** the filter vocabulary and the rubric need no Agility call. They could always be offered.
- **Options:** (a) every entry declares `uses`; a static entry names the tool it describes (`query_assets`, `get_work_item`) and
  exists only when that tool is allowed; (b) static entries are always offered.
- **Recommendation:** (a): a workspace without the generic query tool is not shown how to use it, and one rule (all `uses`
  allowed) covers every entry, which prompts reuse (L-290).
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-94 — Resource reads are audited as `tool_call` rows *(P6-09)*
- **Context:** reads must be audited like tool calls (same limits, cache and audit), but a new audit `kind` needs a schema and
  admin-UI change.
- **Options:** (a) reuse `tool_call` with the action `resource:<manifest id>` (status, duration, requests, asset numbers, masked
  queries, no content); (b) a new `resource_read` kind.
- **Recommendation:** (a) now; (b) if the owner wants to filter resource reads apart from tool calls in the audit view.
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-83 — `get_sprint` reports no capacity *(P6-02)*
- **Context:** the task asked for schedules and capacity "where the instance exposes them". The Agility schema the metadata
  snapshot is built from has a `Schedule` (name, scheduled projects) but no capacity model on a sprint, and the read-only
  tenant offers nothing to verify one against. Schedules are reported; capacity is not.
- **Options:** (a) report the schedule only and say in `notes` that capacity is not reported; (b) read a `Capacity` asset type
  when the instance has one, unverified; (c) estimate capacity from members and sprint length.
- **Recommendation:** (a): (b) cannot be tested against anything real yet and (c) is a plausible number with no source
  (L-033). P6-17 picks it up once an instance with capacity data is available.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-84 — The burndown is read with `asof` queries, not `Hist` *(P6-02)*
- **Context:** ADR-0011 names `rest-1.v1/Hist` the history authority for what changed on one asset. A sprint burndown needs
  the state of many assets at many instants, which `Hist` (one asset per request) cannot give within the request budget;
  `query.v1` with `asof` returns the sprint's items as they were, several instants per request.
- **Options:** (a) `asof` queries of the sprint's items at up to 15 daily points (fewer for big sprints), batched at 20 queries
  per request, bounded by `maxAsOfAgeDays`; (b) `Hist` per item (hundreds of requests); (c) only the begin and now.
- **Recommendation:** (a). Points that cannot be read in full are left out and named. `get_asset_history` (P6-05) keeps
  `Hist` as the authority for one asset.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-85 — Burndown counts estimate of items not in a `completed` status category *(P6-02)*
- **Context:** "done" needs a rule that works on any instance. The status lists carry a rollup category per status
  (`RollupState`, L-142); an item whose status has no category counts as done only when it is closed, otherwise it is
  `unknown` and counted as not done, with a note naming how many.
- **Options:** (a) the rollup category (as built); (b) `AssetState` closed only; (c) a configurable list of status names.
- **Recommendation:** (a): it is the instance's own definition and needs no configuration. Hour-based (task) burndown and
  velocity are follow-ups (P6-17).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-80 — Portfolio roll-ups are computed from the rows read, not from server-side aggregates *(P6-01)*
- **Context:** `get_portfolio_tree` rolls estimates, done items and open defects up a tree of epics. Agility can aggregate
  one relation (`Subs.@Count`, `Rel.Attribute.@Sum`), but the compiler's aggregation form takes no per-status filter and
  sums through the abstract `Workitem` type, which has no estimate: done percentage and open defects cannot be asked for
  that way, and the downcast form (`Subs:Story.Estimate.@Sum`) is unverified on the live instance (L-148).
- **Options:** (a) read the backlog items (stories and defects, `Super` in the tree's epics, up to three pages of the
  workspace's row maximum per type) and compute the roll-ups here, marking every roll-up `incomplete` and the result
  `partial` when a cap, the depth, the budget, a permission or hidden rows cut the set; (b) aggregate upstream (cheaper,
  exact on any size), once verified live.
- **Recommendation:** (a) now, because it is exact whenever it says nothing is cut and honest when it is not; follow up
  with (b) in [P6-15](../tasks/phase-6-tool-breadth/P6-15-portfolio-aggregate-rollups.md) after a live check.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-81 — What "done" means in a roll-up, and how the percentage is taken *(P6-01)*
- **Context:** Agility has no single "done" flag: an item is closed (`AssetState` 128) or has a status whose rollup
  category is *Done*; teams use either. Estimates are optional.
- **Options:** (a) done = closed **or** status category `completed`; percentage by estimate when any counted item has one,
  otherwise by item count, with the basis stated on every epic (`donePercentBasis`); (b) closed only; (c) status
  category only; (d) always by item count.
- **Recommendation:** (a): it matches what people see on a board whichever convention the team follows, and the stated basis
  stops a count-based number being read as effort. Dead assets (deleted, templates, broken down) are never counted.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-82 — The `portfolio` group is served by the stdio server by default *(P6-01)*
- **Context:** the catalogue lists `portfolio` as on by default; the stdio server's group list stopped at `people` in
  Phase 1, so a new group would exist only for HTTP workspaces that enable it.
- **Options:** (a) add `portfolio` to the stdio groups; (b) leave stdio at five groups and let each later group opt in.
- **Recommendation:** (a): same default as the catalogue; the catalogue stays within the 25-tool default target (15 now).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-95 — No typed tool for quality views; recipes only *(P6-03)*
- **Context:** the task asked whether a typed tool such as "test status for a backlog item" pays off under the tool budget
  (L-155: 35 tools with every group, cap 40).
- **Options:** (a) recipes only: every quality question is one `query_assets` call with a filter the recipe shows; (b) a typed
  `get_test_status` (tests of an item with a status roll-up); (c) a typed defects tool.
- **Recommendation:** (a): each case is a single filter (L-294); the live tenant answered all twelve recipe queries through the
  generic tool. Revisit (b) if the tool evals (P6-10) show agents failing the recipe, or the owner wants a status roll-up
  per backlog item ([P6-26](../tasks/phase-6-tool-breadth/P6-26-quality-typed-tool-revisit.md)).
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).
- **Evidence (P6-26, 2026-10-28):** the release LLM eval runs answered the quality and defect questions in 12 of 14
  answers through `search_work_items` or `query_assets` (allowing one lookup); both misses were a second lookup, not a wrong
  tool. Recipes kept; no typed quality tool ([evals](../dev/evals.md)).

### D-96 — Two recipe resources, served through the generic query and metadata tools *(P6-03)*
- **Context:** recipes are manifest entries that prompts (P6-08) can point at. One resource for everything would be long and
  would mix types most workspaces have (tests, defects) with optional ones (regression assets).
- **Options:** (a) two resources, `recipes/tests-and-defects` and `recipes/regression-assets`, each `uses`
  `query_assets`, `describe_asset_type` and `list_asset_types`; `search_work_items` is a "when allowed" mention; (b) one
  resource; (c) one per asset type.
- **Recommendation:** (a): the optional-type warning stays with the optional types, and neither resource is lost when
  `search_work_items` is off (L-295).
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-97 — Regression plans and suites have prose, not validated examples *(P6-03)*
- **Context:** the committed metadata snapshot has `RegressionTest` and `TestSet` but not `RegressionPlan` or
  `RegressionSuite`, and the read-only tenant has no regression assets to learn their relations from (verification.md).
  An example for a relation we cannot check would be exactly the stale recipe L-292 forbids.
- **Options:** (a) prose only ("query like regression tests after `describe_asset_type`"), verify on the writable sandbox
  ([P6-25](../tasks/phase-6-tool-breadth/P6-25-verify-regression-recipes-sandbox.md)); (b) invent examples from Agility
  documentation, unverified; (c) extend the synthetic snapshot by hand.
- **Recommendation:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-98 — Issues, requests, goals, themes and retrospectives get no typed tools *(P6-06)*
- **Context:** the five types are read through `query_assets` and `get_assets`; L-155 caps the tool count. The read-only
  tenant has issues, goals, themes and retrospectives (levels only) and no requests, so there is no usage data yet.
- **Options:** (a) recipes, default tiers and no new tools; (b) typed `list_issues` / `list_requests` now; (c) a typed tool
  per type later, driven by the P6-10 evals and real use.
- **Recommendation:** (a) now, (c) when evals or usage show an agent failing with the generic route (follow-up P6-28).
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-99 — Four recipe resources, grouped by what is read together *(P6-06)*
- **Context:** five types, and the manifest lists every resource to every client, so the list should stay short.
- **Options:** (a) four recipes: issues, requests, goals and themes (one, they are both planning groupings), retrospectives;
  (b) one recipe per type; (c) one recipe for all five.
- **Recommendation:** (a): each recipe stays short enough to read in one go, and the list grows by four rather than five.
- **Built:** (a). Each recipe is offered only when `query_assets` and `get_assets` are both allowed.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-100 — The single-owner fallback is in the computed default tier, not in per-type overrides *(P6-06)*
- **Context:** issues have `Owner`, not `Owners`, so the default tier had no owner column for them. `tierOverrides` could
  fix one type per host, but every deployment would need it.
- **Options:** (a) the tier computation uses `Owner.Name` when the type has no `Owners`; (b) a built-in override table for
  `Issue`; (c) leave issues without an owner by default.
- **Recommendation:** (a): it follows the metadata (L-050) and needs no list of type names; an override still replaces it.
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-101 — The `reports` group is opt-in, gated like `attachments` *(P6-07)*
- **Context:** the catalogue lists `reports` as off by default, "enable per workspace". Composites read several siblings and
  spend the most requests of any tool (up to 54).
- **Options:** (a) a workspace limit `reports` (off by default; a grant can only turn it off) plus `AB_REPORTS` /
  `reports:` for stdio, exactly like the attachment download; (b) a normal group that a workspace names in its tool list;
  (c) on by default.
- **Recommendation:** (a): one mechanism for opt-in groups, impossible to get through an "all tools" list, visible in the
  admin form. The default catalogue stays at 20 tools and 39.2 KB.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-102 — The quality rubric resource is offered with the report that applies it *(P6-07)*
- **Context:** D-92 asked P6-07 to add `work_item_quality` to the rubric resource's `uses`; a resource is available only when
  every tool in `uses` is allowed, so the rubric disappears from callers that have `get_work_item` but not the report group.
- **Options:** (a) add it (the rubric follows the opt-in group); (b) keep `get_work_item` only and let the rubric stay
  visible by default; (c) two resources.
- **Recommendation:** (a): D-92's intent (one rubric for resource, tool and prompt) and the resource's text ("work_item_quality
  uses the same rubric") assume the tool exists. The prompt of P6-08 still reads the rubric through its own entry.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-103 — Rubric checks are mechanical, unassessable criteria are `null`, and dependencies and priority limits are stated *(P6-07)*
- **Context:** the rubric is judgement (clear title, stated value, testable criteria). A server cannot judge; it can count
  words, find phrases and see which fields are set.
- **Options:** (a) mechanical heuristics with the evidence shown per criterion, `null` where nothing was read (no estimate
  field, empty description, priority unreadable), a score range and a level only when the range stays in one level, and a
  note that dependencies are not read; (b) score everything, treating missing as 0; (c) return only the facts and let the agent
  score.
- **Recommendation:** (a): honest and repeatable (L-033); the rubric `version` is cited so scores stay comparable. The
  thresholds (a title of at least four words, an estimate above 8 is large, three testable criteria) are a starting point
  for the owner to tune together with the rubric.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-104 — Report thresholds: pace bands, staleness and duplicate similarity *(P6-07)*
- **Context:** `sprint_health` needs a status, `defect_triage` a "stale" and a "likely duplicate".
- **Options:** (a) pace = done share minus elapsed share: at least -10 points on track, down to -25 at risk, below off
  track (only for a current sprint with a known share done); open items unchanged for 3 days are stale in a sprint and 14
  days for a defect; two defect names with at least 60 % word overlap (three words or more each) are a likely duplicate;
  (b) configurable per workspace; (c) no status at all, only the figures.
- **Recommendation:** (a) now with the rule stated in the result; (b) when an owner asks, as a follow-up of the reports'
  first live use. The figures are always returned beside the status.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-111 — A composite granted without its siblings is a warning, not a refusal *(P6-11)*
- **Context:** a report whose siblings are not granted skips those sections and says so (L-300). An operator may do this
  on purpose (a standup that reads only searches); it may also be an oversight.
- **Options:** (a) advisory warnings in `whoami` and on the workspace and grant pages; (b) refuse to save a list that has a
  composite without its siblings; (c) grant the siblings implicitly.
- **Recommendation:** (a): (b) blocks legitimate narrow grants, (c) widens access behind the operator's back (L-037, T3).
  The warning names the missing tools so the fix is one tick.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-112 — The sibling table lives beside the reports, not on `ToolDefinition` *(P6-11)*
- **Context:** the metadata is needed by `whoami` (inside the tool catalogue's own import graph), the admin API and the
  tests; a field on every definition would put a new optional property in the contract of all 26 tools.
- **Options:** (a) one table `COMPOSITE_SIBLINGS` in `tools/reports/siblings.ts`, tied to each report's sections by a test;
  (b) an optional `siblings` field on `ToolDefinition`; (c) derive it at run time from the sections that ran.
- **Recommendation:** (a): no cycle (`whoami` cannot import `CORE_TOOLS`), one place to edit, and the test fails when a
  report's sections and the table disagree. (b) is easy to move to later.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-113 — The every-tool cost test uses one shared world; the deepest cases stay beside each tool *(P6-11)*
- **Context:** each tool's test file has its own synthetic world and its deepest worst case (four-level trees, every page).
  The all-tools test needs one fixture per tool without importing 8 test files.
- **Options:** (a) `test/tools/worst-case.ts` with one entry per tool over the reports world (plus comments, attachments
  and history), failing for a missing entry, for a call that errors and for one that makes no request; (b) move all worlds
  into shared helpers; (c) a registry the per-file tests fill.
- **Recommendation:** (a) now: it makes a missing fixture a failing test with minimal churn; (b) is a refactor of 3,800
  lines for no new coverage. No tool's declared cost was wrong.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-108 — The LLM eval calls the Messages API over `fetch`, with no SDK dependency *(P6-10)*
- **Context:** the eval is a script the owner runs a few times a release; the repository pins and reviews every dependency
  (supply chain, L-127 – L-132).
- **Options:** (a) `fetch` against `/v1/messages` behind a small `Model` function type; (b) add `@anthropic-ai/sdk` as a root
  dev dependency; (c) shell out to a CLI.
- **Recommendation:** (a): about 30 lines, one request shape, retries on 429 and 5xx, tested with a stubbed `fetch`; the
  `Model` seam makes switching to (b) a one-function change if the eval grows (streaming, batches, thinking blocks).
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-109 — Router baseline: floor rounded down, top-1 and top-3, advisory LLM accuracy, blocking injections *(P6-10)*
- **Context:** the gate must fail on a regression without flapping when an unrelated description changes by a word.
- **Options:** (a) CI fails below a committed floor (top-1 and top-3, rounded down to a whole percent); the LLM eval's tool
  choice is advisory (85 % on the strongest model as a release floor to investigate) and a followed injection blocks the
  release; (b) fail on any change of the exact score; (c) make LLM accuracy a hard gate.
- **Recommendation:** (a): the rounding absorbs one-question wobbles, raising it is a flag, and a probabilistic score should
  not block a release while a followed injection always should. The 85 % figure is a starting point to tune after the first
  runs (P6-33).
- **Built:** (a), baseline 65 % top-1 and 83 % top-3 over 73 questions.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-110 — Default eval model `claude-sonnet-5-5`; the release runs it and the strongest model *(P6-10)*
- **Context:** a weaker model exposes description problems; the strongest is what the best clients run.
- **Options:** (a) default `claude-sonnet-5-5`, `--model claude-opus-5-5` for the second run (about $3 to $6 for both with the
  tool list cached); (b) only the strongest; (c) a matrix of every current model.
- **Recommendation:** (a): cheap enough to run every release, and two tiers show whether a miss is the description or the
  model. Revisit the models when new ones ship; the id is an argument, not code.
- **Built:** (a).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-105 — Prompts on report tools exist only when `reports` is on; no fallback to base tools *(P6-08)*
- **Context:** `review_backlog_item_quality`, `standup` and `triage_defects` use `work_item_quality`, `standup_summary` and
  `defect_triage`, which are in the opt-in `reports` group (D-101). With the group off the default catalogue offers four of
  the seven prompts.
- **Options:** (a) strict: a prompt's `uses` is its tools, the prompt vanishes without them; (b) the entry's `uses` lists
  only the base tools and the text adds the report step when `reports` is granted; (c) two entries per workflow.
- **Recommendation:** (a): the catalogue table's contract, one rule everywhere (L-153), and a stand-up prompt that quietly
  composes its own report from search calls would give a different answer than the tool. (b) as follow-up
  [P6-31](../tasks/phase-6-tool-breadth/P6-31-prompt-fallbacks-without-reports.md) when an owner asks.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-106 — Prompt arguments are strings with a plain-text rule; prompts are not audited or logged *(P6-08)*
- **Context:** MCP prompt arguments are strings. A prompt does no work against Agility, so there is no request, budget or
  scope decision to record.
- **Options:** (a) strings validated by a schema (length, plain text on one line, asset reference shape, `limit` 1-20),
  JSON-quoted into the text, no audit row and no log line; (b) also write an audit row `prompt:<id>` per get; (c) accept
  free text and rely on the model.
- **Recommendation:** (a). (b) is cheap to add if an owner wants to know who asked for which workflow (the host's request
  log already shows `prompts/get`); (c) was refused by L-305.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-107 — Prompts guide a workflow; they do not read Agility to fill the message *(P6-08)*
- **Context:** a prompt could run its tools at `prompts/get` and embed the result (a ready stand-up note) or only tell the
  model which tools to call.
- **Options:** (a) instructions only: the model calls the tools, so every read is a normal, audited, budgeted tool call
  and nothing from Agility sits in a prompt message; (b) embed enveloped tool output in the message (one round trip, but
  prompts get a request budget, audit and error handling of their own, and a client may cache them).
- **Recommendation:** (a). It keeps the untrusted-data path to one place (the tools) and prompts free of upstream failure
  modes; (b) can be added per prompt later without changing the argument contract.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-114 — One schema and one description per shared argument; the lint has no exceptions list *(P6-12)*
- **Context:** the review of all 26 tools found `member` described as "The owner: …" on two tools and "Owner: …" on a third,
  `project` with and without "within the workspace", three spellings of `sprint`, four of `time_range`, a free `asset_type`
  described differently on `query_assets` and `describe_asset_type`. No released argument had to be renamed: the drift was
  in descriptions and types of the same names, so no alias (`deprecations.ts` stays empty).
- **Options:** (a) shared zod schemas in `tools/common.ts` plus a vocabulary the lint checks (the advertised description
  must start with a known text, the type must match); (b) the registry rewrites descriptions of known names at registration
  (tools could not drift, but the source would no longer say what is advertised); (c) review by hand.
- **Recommendation:** (a), built. A legitimately different concept gets its own vocabulary entry (`epicArg`,
  `workItemArg`, the work-item `asset_type` enum), never an exception.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-115 — Counts are `<thing>Count`; `get_sprint` renamed its numeric `items` fields without an alias *(P6-12)*
- **Context:** `get_sprint` used `items` for a number (`totals.items`, `byStatusCategory[].items`, `committed.items`,
  `planned.items`, `carryOver.items`, burndown points) next to `items[]` for rows; the conventions reserve `items` for the
  row array and use `childCount`, `commentCount` for counts.
- **Options:** (a) rename to `itemCount` now; (b) keep `items` and document the exception; (c) rename and keep the old key
  as a deprecated alias for a release.
- **Recommendation:** (a), built: `get_sprint` is new in this unreleased version (its changeset is still pending), before
  1.0 renames need only a changelog entry, and `sprint_health` is the only reader and moved with it. (c) would be the rule
  once an output field has shipped.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-116 — The default `tools/list` has a 36.5 KB target in a test, below the 40 KB cap *(P6-12)*
- **Context:** the default catalogue was 39,179 of 40,000 bytes; the pass brought it to 35,892 (every group: 47,946 to
  44,157 of 72,000). Without a lower tripwire the next default tool would eat the headroom silently and the redesign would
  happen at the cap. Tool count: 20 default, 26 with every read group, 35 with the nine planned Phase 7 write tools
  (26 + 9), five below the cap of 40 (L-155); the write group is opt-in, so it counts only against the 72 KB budget (about
  1.8 KB per write tool would bring it to about 60 KB).
- **Options:** (a) keep only the 40 KB hard cap; (b) add a 36.5 KB target and a 3.6 KB cap per tool to the contract test,
  so a change that crosses it must say why; (c) lower the hard cap.
- **Recommendation:** (b), built. (c) would not change what clients accept (Cursor's cap is about the number of tools; the
  byte budget is ours).
- **Owner (2026-10-27):** Decided: as recommended, (b).

### D-117 — `get_attachment` returns its text only in the enveloped block, not in `structuredContent` *(P6-13)*
- **Context:** the text block carried the attachment text inside the untrusted-data envelope, and `structuredContent.content` repeated
  it (up to 100,000 characters) with cleaning and redaction only. A client that forwards or prefers structured content loses the
  envelope, and the result was twice as large, which matters on the 512 KiB Worker cap.
- **Options:** (a) structured carries metadata only (`attachment { oid, name?, contentType, bytes, characters }`, `asset`, `truncated`);
  (b) keep the text and add an `untrusted: true` marker; (c) keep as it was.
- **Recommendation:** (a), built. The model reads the enveloped block; code that needs the bytes is not an MCP client's job.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-118 — A roll-up percentage is by estimate only when every item read has one *(P6-13, changes D-81)*
- **Context:** with some items estimated and others not, the percentage by estimate ignored the unestimated ones: an epic with two
  estimated (done) and eight unestimated (open) items read 100 % done.
- **Options:** (a) by estimate only when no item read lacks one, else by item count, and show `unestimatedItemCount`; (b) keep the
  estimate basis and only add the count; (c) always by count.
- **Recommendation:** (a), built: the number never hides open work, and the count of unestimated items is in the row. (c) throws away
  the estimates where they are complete.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-119 — `defect_triage` reads the oldest change first *(P6-13)*
- **Context:** the report read the 100 most recently changed open defects, so the stale ones it exists to find were the ones cut
  when there were more than 100, and the stale count was biased low.
- **Options:** (a) read oldest change first (a new `sort_by: oldest_changed` on `search_work_items`, about 20 bytes in `tools/list`)
  and say so when more exist; (b) two sections, the oldest 50 and the newest 50 (two requests); (c) keep newest first and add a note.
- **Recommendation:** (a), built. (b) is the better answer for a large backlog and is part of P6-30 (priority and severity triage).
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-120 — `get_asset_history` does not follow `Scope`, and reads the history of an asset that has since moved into scope *(P6-13)*
- **Context:** an asset moved from a project outside the workspace into one inside it carries its earlier `Scope` in `Hist`, so
  following `Scope` would show an out-of-scope project's OID, and name or status history from before the move is readable.
- **Options:** (a) refuse `Scope` and `Scope.*`; accept that other attributes of an asset that is in scope now are readable for their
  whole history (the asset is in scope, as are its comments); (b) also refuse any window that starts before the asset was last
  moved (needs the move date, not available); (c) leave as it was.
- **Recommendation:** (a), built, and stated in THREAT_MODEL A4. A grant that must not see pre-move history can set `maxAsOfAgeDays`.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-121 — `resources/list` makes no upstream request *(P6-13)*
- **Context:** the per-type resource list called `list_asset_types`: 21 requests and about 1.9 MB of metadata parsed on a cold isolate,
  for every client that lists resources on connect (about 15 ms of Worker CPU, over the Free limit), with a failure answered as an
  empty list.
- **Options:** (a) list the workspace's allowed type names (the default readable types when no list is set), no upstream call; a type
  the instance does not have fails cleanly when read; (b) list only types already in the metadata cache; (c) keep it live.
- **Recommendation:** (a), built. The resource then needs only `describe_asset_type`.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-122 — The stdio server serves the `history` group by default *(P6-13)*
- **Context:** `STDIO_GROUPS` lacked `history`, so stdio users had no `get_asset_history` or `list_recent_changes`, although the
  catalogue lists the group as on by default and the HTTP and Worker hosts serve it. Nothing says it was a decision (compare D-82).
- **Options:** (a) serve it (a read-only group, 2 tools, 20 tools in the default catalogue); (b) leave it out until P6-21 has verified
  `Hist` on a sandbox; (c) make it opt-in.
- **Recommendation:** (a), built; `Hist` was verified read-only on the tenant (P6-05). A test compares the list with the registry.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-153 — Schema failures are answered by the server wrapper, not the SDK *(P6-37)*
- **Context:** measured on SDK 2.3.1 (both protocol revisions share the `tools/call` path): an argument the input schema refuses
  becomes an `isError` result whose text is `Input validation error: Invalid arguments for tool X: ...` with no `AB_*` code, no
  hint and no `_meta`, while a value the handler refuses is `AB_INPUT_INVALID` with a hint.
- **Options:** (a) register the schema with a pass-through validator (the advertised JSON Schema is unchanged) and validate in the
  handler wrapper, once for every tool, answering `AB_INPUT_INVALID` with the argument path, a clipped issue text (never the
  value) and a `Hint:`; (b) leave the SDK message; (c) validate in each tool.
- **Recommendation:** (a), built. Parsed data (defaults applied) still reaches the handler.

### D-135 — Where asset-type metadata is kept across isolates *(P6-39)*
- **Context:** a cold Worker isolate fetches one `meta.v1` document per asset type (9 to 17 for a Phase 6 tool). The task names
  the Cache API, KV or D1. KV is a new binding (and a new Cloudflare resource, which this work may not create); the Cache API is
  per data centre, keyed by URL, and its entries are not ours to purge or authorise.
- **Options:** (a) the host's existing D1 `kv` table through a small `MetadataStore` interface in core (the core stays free of
  storage and `node:*`), keyed `meta1/<instance>/<type>`, storing the parsed identifier-only model with its fingerprint and
  expiry; (b) the Cache API; (c) KV; (d) in-isolate only (status quo).
- **Recommendation:** (a), built; the Node hosts keep their process-wide cache and pass no store. Each stored type is one D1 read
  on a cold isolate instead of one Agility request (D1 reads are not Agility subrequests, but their count against the Free
  plan's subrequest limit is *unverified*). Statuses, prefixes and project trees stay in the isolate for now.
- **Owner:** *(open; built as (a))*

### D-147 — Resolution memo lives on the request context; the standup change-date filter waits for a sandbox *(P6-40)*
- **Context:** Report sections run together and each resolved the same member, team, project or sprint. The task also proposed filtering `standup_summary` on `ChangeDateUTC >= since`, to be done only if a sandbox confirms the filter on all four types.
- **Options:** (a) an optional `memo` map on the per-request context, created by the report handler, with the resolvers memoising through it; the date filter is left for a sandbox check (follow-up P6-55); (b) a module-level cache keyed by request id (breaks L-013, L-096); (c) pass resolved OIDs down as section inputs (changes the sibling tools' inputs).
- **Recommendation:** (a), built.
- **Owner:** *(open; built as (a))*

### D-143 — Portfolio roll-ups stay computed from the rows; the downcast aggregate is not used *(P6-15)*
- **Context:** D-80 (a) computes roll-ups from the stories and defects read under the epics. P6-15 asked for a live check of
  `Subs:Story[...]` aggregates (`@Count`, `Estimate.@Sum`, state conditions). The forms are accepted, but the values are lower than the
  rows read with `Story.Super = epic` on every epic compared (RESEARCH, P6-15), so they are not exact.
- **Options:** (a) keep the computed roll-ups and close P6-15 as "not supported", with the evidence; (b) use the aggregate anyway
  and mark it approximate; (c) search other relation names for an aggregate that matches.
- **Recommendation:** (a): an approximate roll-up that looks exact is worse than a bounded exact one (L-272). A search for another
  relation is a new task if the call cost ever matters.
- **Owner:** *(open; built as (a))*

### D-154 — Prompt completion reuses the list tools and offers fixed sprint words *(P6-32)*
- **Context:** `completion/complete` for `team`, `project` and `sprint` needs candidate names the caller may see.
- **Options:** (a) call the granted list tool (`list_teams`, `list_projects`, `list_sprints`) with the typed text through its handler: same scope, budget and shaping, one call per completion, nothing when that tool is not granted; (b) read the metadata cache; (c) no completion.
- **Recommendation:** (a), built; `sprint` also offers `current`, `previous`, `next` first, and every value must pass the prompt's argument schema. Completion is not audited as a tool call of its own beyond an observer event named `completion:<prompt>.<argument>`.

### D-139 — Large sprints: raise the row bound to 1,000 and trade burndown points for it *(P6-18)*
- **Context:** `get_sprint` read at most five pages of items, so a sprint of more than 500 items lost its history, and every
  history point needs as many pages as the sprint. Aggregations would avoid reading rows but need live measurements and a
  compiler extension (P6-52).
- **Options:** (a) read up to 1,000 items (five to ten pages by page size), keep 60 history queries per call so a bigger sprint
  has fewer points; (b) aggregations now, unmeasured; (c) leave the bound.
- **Recommendation:** (a): it stays inside tested bounds (60 history queries, 20 per request, the P6-42 response-cap guard)
  and needs no new query shape beyond more pages; the live check is P6-51 (L-330).

### D-144 — A very large epic continues with a cursor that carries the totals *(P6-16)*
- **Context:** `get_portfolio_tree` reads three item pages per type and marks the roll-ups `incomplete` beyond that. P6-15 found
  no exact server-side aggregate (D-143).
- **Options:** (a) a continuation cursor carrying per-epic totals and item offsets, the tree re-read on every step and bound by a
  fingerprint; (b) only the documented "get each sub-epic" walk; (c) raise the page cap for everyone.
- **Recommendation:** (a), built, limited to trees of 60 epics or fewer (the cursor stays under its length limit); larger trees keep (b).
  The totals are the caller's own numbers and never carry scope or items; a changed tree refuses the cursor.
- **Owner:** *(open; built as (a))*

### D-140 — `get_velocity` is a planning tool and the default `tools/list` target moves to 37.6 KB *(P6-17)*
- **Context:** velocity needs its own tool (the sprint tool's cost and output are full). The default catalogue was at 35,892 of 36,500
  bytes (D-116); the tool adds 1,315.
- **Options:** (a) planning group, default on, target 37,600 (the 40,000 cap holds, 2.7 KB of headroom left); (b) the opt-in `reports`
  group (its tests and the sibling table assume composite reports); (c) fold velocity into `get_sprint` (costlier, bigger output).
- **Recommendation:** (a): velocity is a basic planning question and (b) mixes a non-composite tool into the reports group.
- **Owner:** *(open; built as (a))*

