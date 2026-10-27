# Phase 6 review

- **Scope:** all Phase 6 code (P6-01 … P6-12): the portfolio, planning, collaboration and history tools, the typed recipes for
  other asset types, the five composite reports, MCP prompts and resources, the router eval and its LLM harness, the cost test and
  composite grant warnings, and the consistency pass. The range reviewed is `cfeeab3..636cd4a`.
- **Date:** 2026-10-27. **Branch:** `task/P6-13-phase-6-review`, on top of `main` at `636cd4a` (#130).
- **Method:** three independent, read-only reviews run in parallel (security, quality and correctness, performance and cost), each
  tracing findings through the code; then every finding was **verified again here** before anything was changed: read in the code,
  and reproduced by a regression test written for it. Findings that did not hold, or held more weakly than reported, are dropped
  or downgraded below with the reason. A live pass of the whole read-only suite against the third-party tenant (levels only,
  nothing from the tenant recorded). The two flaky tests seen in CI were traced to a root cause and fixed, not retried.
- **Checks:** see [Sizes and numbers](#sizes-and-numbers) and [Live verification](#live-verification-2026-10-27).

## Verdict

**Ready for the v0.6 release candidate, with the owner's steps still to do** (the OAuth client runs P6-14, the first LLM eval run
P6-33, the release itself). No critical or high security finding. The reviews found two policy gaps in the history and attachment
tools, three high performance findings and five medium correctness findings; all of them are fixed here with regression tests, the
two flaky tests are fixed at their roots, and what is larger than a review fix became ten new tasks (P6-39 … P6-48). The design
held where the reviewers pushed hardest: scope on every row and every level of the portfolio tree, the opt-in groups, the
composites reading only through granted siblings, structured query construction, the attachment stream limits, and the envelope on
every output path.

## Findings

IDs are the reviewers' (S = security, Q = quality, P = performance). **Fixed** means fixed in this PR with a test that fails with
the fix reverted (mutation-checked, one revert at a time, for the ones marked *mc*; for the others the test asserts what the unfixed code
did not do, and was not separately reverted). Severity is the reviewers', changed where noted.

### High

**P-H1 — `resources/list` ran `list_asset_types` (21 requests, about 1.9 MB of metadata) on a cold cache** — **fixed.** Confirmed: the
per-type template's `list` called `list_asset_types`, which loads about 20 types one after another; every client that lists
resources on connect paid it on each new isolate, spent 21 of the 45 Free-plan calls and swallowed a failure as an empty list.
The list is built from the workspace's allowed type names with no upstream call and a type the instance lacks fails cleanly when read
(D-121). Test: `resources/list` makes zero requests (`resources.test.ts`, and in the live suite). Lesson L-327.

**P-H2 — Cold-cache calls are dominated by serial `meta.v1` loads (9 to 17 per Phase 6 tool)** — **partly fixed, rest deferred.**
Confirmed from the request traces. Independent type loads now go out together (`MetadataService.prefetch`, counted by the same
budget) in `get_portfolio_tree`, `get_sprint` and `list_recent_changes`; a test shows the loads overlap and a duplicate name loads
once. The metadata the loads pull in through relations (status lists, the sibling reports' dependencies) is still serial, and the
cache is per isolate: a cache that outlives the isolate and Phase 6 paths on the Worker bench are
[P6-39](../tasks/phase-6-tool-breadth/P6-39-keep-instance-metadata-across-isolates-and-measure.md).

**P-H3 — `work_item_quality` regular expression is cubic on hostile text** — **fixed** (the coordinator had confirmed it). Measured
again: 2.2 KB of `given when ` repeated is 33 ms, 5.5 KB 521 ms, 11 KB 4.9 s; input is capped at 4,000 characters, so the realistic
worst case is 150 to 250 ms, but anyone who can edit a description controls it. Now three anchored searches in order
(`hasGivenWhenThen`); a 4.4 KB hostile string takes under 50 ms in the test (it took over a second before). *mc.* Lesson L-326.

### Medium

**S1 — `get_attachment` echoed the uploader's `ContentType` in an error message outside the envelope** — **fixed** (the reviewer
called it medium-low; it is the one finding in which an uploader's text reaches the model unwrapped). The message no longer names
the type; the type is in the enveloped details only. Test: a hostile type of 70 characters ("ignore prior rules and …") appears
only inside the untrusted-data block. *mc.* Lesson L-324.

**S2 — `get_asset_history` ignored `maxAsOfAgeDays`** — **fixed** (confirmed by the coordinator). A window that starts before
`now - maxAsOfAgeDays` is refused before any request, as the compiler does for `as_of`. Test with a 30-day limit; a window inside
it still works. *mc.* Lesson L-323.

**Q-M1 — `release_readiness` could never say `ready` for an epic with more than 100 backlog items** — **fixed.** Reproduced with 126
done stories: the tree set `partial` because it listed 100 of 126, the report took that for an incomplete read, said `unknown` and
"counts are lower bounds". Completeness now comes from the roll-up's own `incomplete` flag; the listing cap only makes the report
`partial`. Test: 126 done stories give `ready`, `lowerBound: false`. *mc.* Lesson L-328.

**Q-M2 — A roll-up percentage by estimate ignored unestimated items** — **fixed.** Confirmed in the code and by the existing
fixture (one of the five items of an epic had no estimate and the row said 63.6 %). The percentage is by estimate only when every
item read has one, otherwise by count, and the row carries `unestimatedItemCount` (D-118, which changes D-81). Tests: the fixture
now expects 60 % by count with one unestimated item; the reports test reads an epic with eight open unestimated items.

**Q-M3 — `defect_triage` read the 100 most recently changed defects, so the stale ones were the ones cut** — **fixed.** `search_work_items`
gains `sort_by: oldest_changed` (about 20 bytes in `tools/list`) and the report uses it; the note says so when more exist (D-119).
Test: with a page of two, the stale defect is in the page and the note appears. Two sections (oldest and newest) are P6-30.

**Q-M4 — Composites did not set `partial` when rows were hidden by the scope recheck** — **fixed, narrowed.** `get_portfolio_tree`
already did (hidden rows cut every roll-up, which the review had noted as the contrast); `get_sprint`, `sprint_health`,
`defect_triage` and `standup_summary` now set `partial` for hidden rows too. Test: a sprint whose snapshots hold a foreign project's
item is `partial` with the note (*mc* for `get_sprint`).

**Q-M5 — `get_sprint` history points did not read `AssetState`, the current point did** — **confirmed, fixed differently.** Reproduced: a
closed story with no status counts as done in the current totals and as remaining at every earlier point. The reviewer's fix (select
`AssetState` on every `asof` query) **timed out on the real tenant**: with it, `get_sprint` on a past and a current sprint failed with
`AB_AGILITY_TIMEOUT` in the live pass, and without it both passed (bisected by reverting only that attribute; recorded in RESEARCH
§1.4). The tool now says so instead: a note names how many closed items have no status category and are counted as done in the totals
and the last point but as remaining at earlier points. Test: the note appears with such an item and not without. *mc.* Lesson L-330.

**P-M1 — `defect_triage` tokenised every name twice per pair** — **fixed.** Word sets are built once per defect; the pair loop
compares sets (4,950 pairs of 100 defects). Behaviour unchanged (existing tests); the duplicate list order and a cut note are P6-47.

**P-M2 — `get_asset_history` fetches the whole history and fails near 520 versions with a generic message** — **partly fixed.**
Confirmed by the reviewer's measurement (a 503 KiB body is the Free cap). The failure now says what the history is too big for and
what to do (fewer fields, or `list_recent_changes`); the version cut keeps the most recent versions and says so (Hist order is not
guaranteed). Whether `Hist` can be narrowed by date is unverified (RESEARCH 1.4) and is
[P6-43](../tasks/phase-6-tool-breadth/P6-43-read-long-asset-histories-within-the-response-cap.md).

**P-M3 — Composite sections run serially and repeat resolution** — **deferred** to
[P6-40](../tasks/phase-6-tool-breadth/P6-40-run-independent-report-sections-together-and-share.md). Real, but `runSection` counts a
section's requests as `budget.used` before and after, which is wrong under concurrency, so the fix needs a child budget per
section and a per-request resolution memo; not a review-sized change.

**P-M4 — `get_sprint` pages and history chunks are sequential** — **deferred** to
[P6-41](../tasks/phase-6-tool-breadth/P6-41-read-sprint-pages-and-burndown-history-concurrentl.md); the request count is bounded
(60 queries, 3 requests) and unchanged.

**P-M5 — Redaction was slow on large plain text (77 ms for a 100 KB hex body)** — **fixed.** Each pattern now runs only when a
literal it needs is in the text; the same body takes 2.5 ms, prose 0.8 ms (was 8). The guards are necessary conditions, so a secret
is never skipped (the redaction corpus and a new test with a secret inside a hex body pass). The doubled attachment payload went
with D-117 (S5). Lesson L-326.

**P-M6 — The core test suite is about 1.8 times slower** — **partly fixed.** The timeout root cause is fixed below (F2);
shortening the suite itself (shared fixtures, `isolate: false`) is [P6-44](../tasks/phase-6-tool-breadth/P6-44-cut-the-core-test-suite-s-runtime.md).

### Low

**S3 — History can show values from before an asset entered scope, including a previous out-of-scope project OID** — **fixed in part,
accepted in part.** Confirmed: `Scope` is the root path, so no guard applied. `Scope` and `Scope.*` are refused in
`get_asset_history` (D-120, THREAT_MODEL A4). Name, status and other attributes of an asset that is in scope today stay readable for
their whole history: the asset is in scope now, and `maxAsOfAgeDays` is the grant-level limit.

**S4 — A failed or refused `get_attachment` left no asset or attachment id in the audit** — **fixed.** `AbError` carries `audit`
facts (ids, size, type, never content or Agility text) that the server's observer records on the error row; set for a metadata
refusal, an oversize body, a wrong response type and a non-text body. Test through the server's `onToolCall`.

**S5 — `get_attachment` repeated the text in `structuredContent` with no envelope** — **fixed** (D-117, L-325): structured output is
metadata only.

**S6 — `sprint_health` re-emits its sibling's notes as trusted lines** — **fixed, hardened later.** Latent (every note today is static),
but the notes were flattened strings. They are forwarded as untrusted data now (test: none appears outside the envelope). Mapping
them to codes and a lint is [P6-48](../tasks/phase-6-tool-breadth/P6-48-forward-sibling-facts-in-composites-as-codes-with.md).

**S7 — stdio does not serve the `history` group** — **fixed** (confirmed by the coordinator; D-122, L-329). A test compares the list
with the registry's groups.

**S8 — A batched burndown request can exceed the response cap and fail the whole call** — **deferred** to
[P6-42](../tasks/phase-6-tool-breadth/P6-42-let-a-burndown-chunk-that-is-too-large-mark-its-po.md). Bounded (20 queries, 3 requests)
and loud, not a leak; it needs a fake that answers an oversized chunk.

**S9 — `get_portfolio_tree` could trip the trusted `in` limit on very large trees** — **fixed.** With three levels of 700 epics the
item query named 2,100 and failed. The item read now names at most 2,000 epics, the tree says so and is `incomplete`. Test with
2,100 synthetic epics.

**S10 — Prompt and resource details** — **fixed, one dropped.** `review_backlog_item_quality` now declares `search_work_items` in
`uses` (it calls it when no asset is given; the test reads both shapes of the prompt). Prompt arguments refuse Unicode format
characters (right-to-left override, zero width; `\p{Cf}`), which also refuses a zero-width joiner in an emoji. `resources/list` is P-H1.
**Dropped:** `readPriority` runs one compiled, scope-checked query on the type the sibling returned. It reads only the item the caller
just read with `get_work_item` and is covered by `grantedTools` through that sibling; no change.

**Q-L1 — History diff and ordering edges** — **fixed in part.** Multi-valued relations are sorted before comparing (a reorder is not a
change); the version cut sorts by moment and keeps the most recent; `list_recent_changes` orders by instant, not by text (stamps with
different fractional digits). **Dropped:** "the description says Not paged but accepts `limit`": the row cap is the documented bound
(D-90); the generic note text is not misleading.

**Q-L2 — Standup `finished`, partial by string match** — **fixed in part.** `partial` is a boolean tracked beside each note (a
reworded note cannot drop it); an unreadable change date on the last row of a cut page now says the list is not complete; the
standup note says a closed item counts as finished when it changed in the window, not when it was closed (closing time is not read).

**Q-L3 — Defect triage pair order and caps** — **deferred** to [P6-47](../tasks/phase-6-tool-breadth/P6-47-polish-defect-triage-standup-and-get-sprint-output.md).

**Q-L4 — `work_item_quality` edge semantics** — **fixed in part.** The acceptance fallback scores only the text after the words
"acceptance criteria" (prose that merely mentions the phrase scored full marks). The zero estimate, `readPriority` hiding budget
errors and the cut description are [P6-46](../tasks/phase-6-tool-breadth/P6-46-settle-the-edge-semantics-of-work-item-quality.md).

**Q-L5 — `get_sprint` small points** — **deferred** (items block by position, sprint end date possibly inclusive; the second is
unverified) to P6-47.

**Q-L6 — Duplication and drift after P6-12** — **partly fixed, rest deferred.** `refine_backlog` no longer asks for a "backlog
order" the tool cannot give (it reads 50 open stories and keeps the first N without a sprint, and says the rank is not sortable).
The five `num()` copies, `text()`, `round` and the two meanings of `minimal_output` are
[P6-45](../tasks/phase-6-tool-breadth/P6-45-remove-the-duplicated-tool-helpers-and-the-double.md).

**Q-L7 — An all-zero ranking gave the alphabetical-first tool a free hit in the router eval** — **fixed.** A question sharing no word
with any tool is a miss. The baseline did not move (see numbers).

**P-L1 — Prompt schemas are not prewarmed** — **deferred** to P6-39. **P-L2 — per-request Set copies** — **dropped:** the whole build
is 0.10 to 0.14 ms against a 2 ms tripwire. **P-L3 — O(n²) array copies in tree building** — **fixed** (`push`, a `Set` for the
frontier). **P-L4 — Attachment reader memory** — **dropped:** peak about 5 MiB at the 1 MiB cap against 128 MB. **P-L5 — Roll-ups cap at
three pages per type** — **already tracked** as P6-15 and P6-16.

### Flaky tests

**F1 — `answers every OAuth denial with the one 401` (worker): "Body is unusable: Body has already been read"** — **fixed.** The reviewer's
cause was a hypothesis (it could not be reproduced): a `dispatchFetch` response is a live stream, the test made a second request
and read the first body afterwards. Fixed both ways proposed: `expectDenied` reads each response's body and header at once, and the
worker host buffers every response in `call` and `adminApi` so no test holds a live stream. The two denial tests passed on workerd after the change (50 s). The whole OAuth worker file did not
finish inside 10 minutes on this machine, so the full file ran in CI only. A failure that showed only under load cannot be proven
gone by one run: the lesson says what to look for if it returns (L-321).

**F2 — `harness.test.ts` "formatted rows are exactly the rows shown" and `resolve.property` time out under load** — **fixed.** Measured
3.1 s (of 5 s) and 0.6 s idle. `core` and `auth` set `testTimeout: 20 s` like the other projects; the formatter property runs 100
runs of up to 30 rows (it does not depend on size) and the resolver property 250 runs. Seeds are fixed, so this is deterministic.
Lesson L-322.

### Not changed, by design

- Checked and found sound by the reviewers and re-read here: the opt-in gating of `attachments` and `reports` at resolution,
  registration and handler; resources and prompts following tool availability; composites reading only granted siblings with their
  own scope and budget; history built on `rest-1.v1/Hist` with validated type, id and selection; the attachment fetch (scope through
  the parent asset, no redirect following, type checked twice, size counted on the stream, UTF-8 decoded fatally); the portfolio tree
  scope recheck at every level; the burndown bounds; cursor binding; logging and secrets in the eval harness.
- Accepted and now written down: the history of an asset that moved into scope is readable (D-120); `get_attachment` reads the
  content type from uploader-controlled metadata before the response check (it is checked again on the response).

## Sizes and numbers

| Measure | Before (`636cd4a`) | After this PR |
|---|---|---|
| Tools: default / every read group | 20 / 26 | 20 / 26 |
| `tools/list` bytes: default / every group | 35,892 / 44,157 (limits 40,000 and 72,000; target 36,500) | 35,905 / 44,132 |
| Cost of the `oldest_changed` value of `search_work_items.sort_by` | | about 20 bytes (and the sort description shortened by the same) |
| `resources/list` upstream requests on a cold cache | 21 | 0 |
| `redact()` on 100 KB of hex / prose | 77 ms / 8 ms | 2.5 ms / 0.8 ms |
| `work_item_quality` Given/When/Then check on a 4.4 KB hostile description | over 1 s (cubic) | under 50 ms in the test |
| Router eval baseline, 73 questions (top-1 / top-3) | 75 % / 87 % (committed floor) | 75.3 % / 87.7 %, floor unchanged |
| Property tests: formatter / resolver | 3.1 s / 0.6 s (5 s limit) | 100 runs of up to 30 rows / 250 runs, 20 s limit |

The per-request server build (0.10 ms default, 0.14 ms for every group) and the declared cost of every tool (cold, fake) were measured
by the performance review and are unchanged. Full run (`pnpm test`, including the workerd suites): 152 files, 3,175 tests passed, 1 skipped, 1,039 s on a loaded machine, twice (before and after the live-pass fixes).

## Live verification (2026-10-27)

`pnpm test:live` against the third-party tenant (Agility 26.0.3.2, hosted, read-only, every request through the guard, one file at a
time; nothing from the tenant is printed or recorded here): **11 files, 33 tests, all passed** on the last run (257 s). Results are
levels only.

| Area | Result |
|---|---|
| Every catalogue tool through the production client, cold cache, within its declared cost | 25 of 26 tools run clean (`get_attachment` is excluded: the guard allows no content request, P6-19); the reports run with only themselves granted (sections skipped and named) |
| Reports with their siblings (`reports.live.test.ts`) | the composite report tests passed, including a report with one sibling not granted, which skipped that section and made no request for it |
| Portfolio, planning, history, collaboration, other asset types, recipes | passed: roll-ups consistent (done and open counts never above the item count, percentages 0 to 100); a past and a current sprint with at most 15 ordered burndown points; history consistent with current values; conversations and attachment metadata listed; `get_attachment` refused at its metadata checks |
| Resources and prompts | every resource listed and read (tool-backed ones enveloped); every prompt listed and built from invented arguments; `resources/list` and the prompts made **0** upstream requests (new in this PR) |
| Sizes (levels, as recorded by the per-area suites) | epics 100+, items counted in a tree fewer than 100, sprints with hundreds of items (L-279) |

What the live pass found, besides passing:

- **A reviewer fix that made things worse** (Q-M5): selecting `AssetState` on every `asof` query timed `get_sprint` out on the tenant;
  reverted and replaced by a note (above, RESEARCH §1.4, L-330). The first runs failed on exactly this in two tests; the fix was
  bisected by reverting only that attribute.
- **The history window limit and the clock** (S2): `last 365 days` with `maxAsOfAgeDays` 365 was refused because the window was parsed
  at one instant and judged at the next. One instant is used now (regression test with a moving clock).
- **Three live tests had drifted** and are fixed: the catalogue loop called the reports and `get_sprint` without valid arguments and
  treated an ambiguous "current sprint" as an error (a tenant with several running sprints answers a clean ambiguity), and the sprint test
  still read `items` (renamed `itemCount` by P6-12). Live tests are not in CI, so drift shows only at a live run; the loop now covers the
  five reports.
- **Not covered, as before:** the attachment download (the guard refuses it, P6-19), the activity stream (D-89), requests and
  regression assets (no data on this tenant, P6-25, P6-27), and anything that needs a writable sandbox.

## Matrix and release

Nothing in Phase 6 changes the client matrix. What stays with the owner is listed under *Owner steps* in
[docs/pending-decisions/phase-6.md](../pending-decisions/phase-6.md#owner-steps): the OAuth client runs ([P6-14](../tasks/phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md)),
the first LLM eval run ([P6-33](../tasks/phase-6-tool-breadth/P6-33-first-llm-eval-run.md), a paid API call), the v0.6 release (the
owner merges the Version Packages PR) and the open decisions D-80 to D-122:

- D-80 to D-82 (P6-01): roll-ups from rows read; what "done" means and the percentage; the `portfolio` group on stdio.
- D-83 to D-85 (P6-02): no capacity; burndown by `asof`; remaining estimate.
- D-86 to D-88 (P6-04): where the attachment download is switched on; allowed types; text size.
- D-89 to D-91 (P6-05): no activity stream; history not paged; four work-item types in recent changes.
- D-92 to D-94 (P6-09): the rubric in core; resources offered with their tools; reads audited as tool calls.
- D-95 to D-97 (P6-03): recipes only for quality views; two recipe resources; no validated examples for regression assets.
- D-98 to D-100 (P6-06): no typed tools for other asset types; four recipe resources; the single-owner fallback tier.
- D-101 to D-104 (P6-07): the `reports` group is opt-in; rubric resource with the report; mechanical rubric checks; thresholds.
- D-105 to D-107 (P6-08): prompts only with reports; plain-text arguments; prompts guide, they do not read.
- D-108 to D-110 (P6-10): the eval over `fetch`; the baseline; the default model.
- D-111 to D-113 (P6-11): a composite without its siblings is a warning; the sibling table beside the reports; one shared cost world.
- D-114 to D-116 (P6-12): one schema per shared argument; `itemCount`; the 36.5 KB target.
- D-117 to D-122 (this review): attachment text only in the envelope; percentage by estimate only when complete; defect triage oldest
  first; no `Scope` in history; `resources/list` with no request; stdio serves `history`.

## New work

Lessons L-321 to L-330. Decisions D-117 to D-122. Tasks P6-39 to P6-48 (metadata across isolates and Phase 6 bench paths; report
sections together; sprint reads together; an oversized burndown chunk; long histories; test runtime; duplicated helpers; quality
edges; triage and sprint polish; composite notes as codes). P6-01 to P6-12 are set to `done` (their work is merged; this review
closes them) and P6-13 to `review`; P6-14 stays `todo` (the owner's client runs).
