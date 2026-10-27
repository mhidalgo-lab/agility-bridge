# Pending decisions — Phase 6

> Open questions and owner steps from Phase 6. Answer inline (`**Owner:** …` with a date).

> The owner authorised the whole phase as a batch (2026-10-27): decisions marked *built as …* are implemented at their
> recommendation; say so if you want the alternative.

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
- **Owner:** pending.

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
- **Owner:** pending.

### D-91 — `list_recent_changes` covers the four work-item types, not portfolio items *(P6-05)*
- **Context:** the tool queries Story, Defect, Task and Test through the same filters and merge as `search_work_items`
  (one batched `query.v1`, per-type cursors). Epics and other portfolio items live under their own scope strategy and
  belong with the portfolio tools ([P6-01](../tasks/phase-6-tool-breadth/P6-01-tools-portfolio.md)). `get_asset_history`
  works on any readable asset type, epics included.
- **Options:** (a) four work-item types now; portfolio items later; (b) add `Epic` now.
- **Recommendation:** (a), with [P6-22](../tasks/phase-6-tool-breadth/P6-22-recent-changes-portfolio-items.md) adding epics
  once P6-01 settles how portfolio items are listed.
- **Owner:** pending.

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
- **Owner:** pending.

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
- **Owner:** pending.

### D-88 — How much text one call returns *(P6-04)*
- **Context:** the download cap (1 MiB by default) bounds what the bridge reads, but a model's context should not take
  a megabyte of text in one result, and the output shaper caps one value at 4,000 characters.
- **Options:** (a) return up to `max_characters` (default 20,000, at most 100,000) in one enveloped text block, with a
  note and `truncated` when cut; ranged reads later (P6-20); (b) page through the text with a cursor now; (c) return
  the whole text up to the byte cap.
- **Recommendation:** (a): bounded results by default, and the common case (a log excerpt, a small CSV, a note) fits.
- **Built:** (a).
- **Owner:** pending.

### D-92 — The quality rubric is defined in core now, ahead of `work_item_quality` *(P6-09)*
- **Context:** the catalogue lists `agility-bridge://rubrics/backlog-item-quality` as "the versioned quality rubric (JSON)
  used by `work_item_quality`", but P6-07 (that tool) is not built yet.
- **Options:** (a) define the rubric in core now (`packages/core/src/rubric.ts`, version `1.0.0`) and serve it; P6-07 and the
  `review_backlog_item_quality` prompt import the same object; (b) defer the resource until P6-07.
- **Recommendation:** (a): one rubric for the resource, the tool and the prompt cannot drift, and the version is fixed from the
  first release. The criteria and weights are a starting point for the owner to tune; any change bumps `version`.
- **Built:** (a). The rubric resource is offered when `get_work_item` is allowed; P6-07 should add `work_item_quality` to its
  `uses` when it lands.
- **Owner:** _open_.

### D-93 — Static resources are offered only with the tool they describe *(P6-09)*
- **Context:** the filter vocabulary and the rubric need no Agility call. They could always be offered.
- **Options:** (a) every entry declares `uses`; a static entry names the tool it describes (`query_assets`, `get_work_item`) and
  exists only when that tool is allowed; (b) static entries are always offered.
- **Recommendation:** (a): a workspace without the generic query tool is not shown how to use it, and one rule (all `uses`
  allowed) covers every entry, which prompts reuse (L-290).
- **Built:** (a).
- **Owner:** _open_.

### D-94 — Resource reads are audited as `tool_call` rows *(P6-09)*
- **Context:** reads must be audited like tool calls (same limits, cache and audit), but a new audit `kind` needs a schema and
  admin-UI change.
- **Options:** (a) reuse `tool_call` with the action `resource:<manifest id>` (status, duration, requests, asset numbers, masked
  queries, no content); (b) a new `resource_read` kind.
- **Recommendation:** (a) now; (b) if the owner wants to filter resource reads apart from tool calls in the audit view.
- **Built:** (a).
- **Owner:** _open_.

### D-83 — `get_sprint` reports no capacity *(P6-02)*
- **Context:** the task asked for schedules and capacity "where the instance exposes them". The Agility schema the metadata
  snapshot is built from has a `Schedule` (name, scheduled projects) but no capacity model on a sprint, and the read-only
  tenant offers nothing to verify one against. Schedules are reported; capacity is not.
- **Options:** (a) report the schedule only and say in `notes` that capacity is not reported; (b) read a `Capacity` asset type
  when the instance has one, unverified; (c) estimate capacity from members and sprint length.
- **Recommendation:** (a): (b) cannot be tested against anything real yet and (c) is a plausible number with no source
  (L-033). P6-17 picks it up once an instance with capacity data is available.
- **Owner:** pending (built as (a)).

### D-84 — The burndown is read with `asof` queries, not `Hist` *(P6-02)*
- **Context:** ADR-0011 names `rest-1.v1/Hist` the history authority for what changed on one asset. A sprint burndown needs
  the state of many assets at many instants, which `Hist` (one asset per request) cannot give within the request budget;
  `query.v1` with `asof` returns the sprint's items as they were, several instants per request.
- **Options:** (a) `asof` queries of the sprint's items at up to 15 daily points (fewer for big sprints), batched at 20 queries
  per request, bounded by `maxAsOfAgeDays`; (b) `Hist` per item (hundreds of requests); (c) only the begin and now.
- **Recommendation:** (a). Points that cannot be read in full are left out and named. `get_asset_history` (P6-05) keeps
  `Hist` as the authority for one asset.
- **Owner:** pending (built as (a)).

### D-85 — Burndown counts estimate of items not in a `completed` status category *(P6-02)*
- **Context:** "done" needs a rule that works on any instance. The status lists carry a rollup category per status
  (`RollupState`, L-142); an item whose status has no category counts as done only when it is closed, otherwise it is
  `unknown` and counted as not done, with a note naming how many.
- **Options:** (a) the rollup category (as built); (b) `AssetState` closed only; (c) a configurable list of status names.
- **Recommendation:** (a): it is the instance's own definition and needs no configuration. Hour-based (task) burndown and
  velocity are follow-ups (P6-17).
- **Owner:** pending (built as (a)).

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
- **Owner:** *(open; built as (a))*

### D-81 — What "done" means in a roll-up, and how the percentage is taken *(P6-01)*
- **Context:** Agility has no single "done" flag: an item is closed (`AssetState` 128) or has a status whose rollup
  category is *Done*; teams use either. Estimates are optional.
- **Options:** (a) done = closed **or** status category `completed`; percentage by estimate when any counted item has one,
  otherwise by item count, with the basis stated on every epic (`donePercentBasis`); (b) closed only; (c) status
  category only; (d) always by item count.
- **Recommendation:** (a): it matches what people see on a board whichever convention the team follows, and the stated basis
  stops a count-based number being read as effort. Dead assets (deleted, templates, broken down) are never counted.
- **Owner:** *(open; built as (a))*

### D-82 — The `portfolio` group is served by the stdio server by default *(P6-01)*
- **Context:** the catalogue lists `portfolio` as on by default; the stdio server's group list stopped at `people` in
  Phase 1, so a new group would exist only for HTTP workspaces that enable it.
- **Options:** (a) add `portfolio` to the stdio groups; (b) leave stdio at five groups and let each later group opt in.
- **Recommendation:** (a): same default as the catalogue; the catalogue stays within the 25-tool default target (15 now).
- **Owner:** *(open; built as (a))*

### D-95 — No typed tool for quality views; recipes only *(P6-03)*
- **Context:** the task asked whether a typed tool such as "test status for a backlog item" pays off under the tool budget
  (L-155: 35 tools with every group, cap 40).
- **Options:** (a) recipes only: every quality question is one `query_assets` call with a filter the recipe shows; (b) a typed
  `get_test_status` (tests of an item with a status roll-up); (c) a typed defects tool.
- **Recommendation:** (a): each case is a single filter (L-294); the live tenant answered all twelve recipe queries through the
  generic tool. Revisit (b) if the tool evals (P6-10) show agents failing the recipe, or the owner wants a status roll-up
  per backlog item ([P6-26](../tasks/phase-6-tool-breadth/P6-26-quality-typed-tool-revisit.md)).
- **Built:** (a).
- **Owner:** _open_.

### D-96 — Two recipe resources, served through the generic query and metadata tools *(P6-03)*
- **Context:** recipes are manifest entries that prompts (P6-08) can point at. One resource for everything would be long and
  would mix types most workspaces have (tests, defects) with optional ones (regression assets).
- **Options:** (a) two resources, `recipes/tests-and-defects` and `recipes/regression-assets`, each `uses`
  `query_assets`, `describe_asset_type` and `list_asset_types`; `search_work_items` is a "when allowed" mention; (b) one
  resource; (c) one per asset type.
- **Recommendation:** (a): the optional-type warning stays with the optional types, and neither resource is lost when
  `search_work_items` is off (L-295).
- **Built:** (a).
- **Owner:** _open_.

### D-97 — Regression plans and suites have prose, not validated examples *(P6-03)*
- **Context:** the committed metadata snapshot has `RegressionTest` and `TestSet` but not `RegressionPlan` or
  `RegressionSuite`, and the read-only tenant has no regression assets to learn their relations from (verification.md).
  An example for a relation we cannot check would be exactly the stale recipe L-292 forbids.
- **Options:** (a) prose only ("query like regression tests after `describe_asset_type`"), verify on the writable sandbox
  ([P6-25](../tasks/phase-6-tool-breadth/P6-25-verify-regression-recipes-sandbox.md)); (b) invent examples from Agility
  documentation, unverified; (c) extend the synthetic snapshot by hand.
- **Recommendation:** (a).
- **Built:** (a).
- **Owner:** _open_.

