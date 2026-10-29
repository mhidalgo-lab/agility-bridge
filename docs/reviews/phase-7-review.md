# Phase 7 review

- **Scope:** the write path of Phase 7 (P7-01 … P7-06): the write framework and pipeline, the approval page, the write limiter, the
  nine write tools (wave 1, wave 2, lifecycle) and their tests, as merged on `main` at `4cc7a4b` (range `2af2c71..4cc7a4b`).
  P7-07 (sandbox verification) and P7-08 (docs) are not part of it; the real-Agility behaviour of every write stays *unverified*.
- **Date:** 2026-10-29. **Branches:** `task/P7-09-review-fixes-writes` (this PR) and `task/P7-09-review-fixes-perf` (another agent,
  bench, declared costs and storage queries).
- **Method:** three independent, read-only reviews (security, quality and correctness, performance and cost), each reading the code and
  tests without changing or running anything against Agility. Every finding was then **verified against the code here** before it
  was changed; a fix starts with a test that fails without it (L-330). One regression check was run by reverting the client and the
  limiter and re-running the new tests: the five tests that cover those two files failed, and passed again with the fixes.
  Findings that are hypotheses about Agility's behaviour are marked as such and left for the sandbox.
- **Status of P7-09:** unchanged (`todo`): it waits for the sandbox run (P7-07) and the release.

## Verdict

**No critical or high security finding.** The layering held where the reviewers pushed: every enablement layer is re-checked inside the
tool, the approval binds tool, actor, operation, target and every old and new value, grants and rounds are single use, the intent is
audited before the send, nothing is retried, and no caller input can name an attribute, a relation or a URL. The reviews found one
finding that two reviewers rated medium or high (the lost "may or may not have been applied" hint), one medium in the close tool, a
set of quality findings about Agility-sourced text and no-op rules, and several low items. Thirteen are fixed here; four become
follow-up tasks (P7-26 … P7-29); three hypotheses join the sandbox checklist (P7-07); the performance findings are in the other PR.

## Findings

IDs are the reviewers' (S = security, Q = quality, P = performance). Verdicts: **fixed here**, **fixed in the performance PR**,
**deferred to <task>**, **sandbox** (needs a real Agility, in P7-07), **not a defect** (with the reason).

### Medium

**S-M1 / Q-1 — The "may or may not have been applied" hint never reached the agent; a 2xx with an empty body was an error** — **fixed
here** (high by the quality reviewer; verified at `pipeline.ts`). The hint was added only when the error had none, but the real client
gives timeouts and unavailable errors their own "try again" hint, so the agent was told to repeat a write that is never retried because
it may have succeeded; the test used a hint-less fake error. Now every failure after the request started (timeout, unavailable, wrong
instance, internal) gets the "check the item first" hint in place of the client's, and the audit outcome carries a note; refusals that
prove nothing happened (401, 403, 404, 429, other 4xx) keep theirs. A 2xx to a write with an empty or unreadable body is reported as
applied (audited `ok` with a note, the result says the answer could not be read and not to repeat the write). Tests go through the real
client with a fake `fetch` (500, 503, timeout, 403, empty and non-XML 200). Lesson L-404.

**S-M2 / Q-6 — `close_asset` counted only children it could read and showed `OpenChildren 0 -> 0`** — **fixed here** (verified
at `lifecycle.ts`; the hypothesis that `QuickClose` cascades is not verified). A denied or not-allowed child type, or an epic in a
project-restricted workspace (its children may sit elsewhere), now refuses the close with the reason before any approval, instead of
skipping the type. Decision D-191. Whether `QuickClose` closes children, and whether to prefer `Close`, is for the sandbox (P7-07,
P7-22). Test: denied `Task`, dry run and confirmed, no approval and no request; the epic rule is tested on `openChildren` directly
(the fixture's epic has no close operation).

**S-M3 — Elicitation proves the client answered, not that a person did** — **deferred to
[P7-26](../tasks/phase-7-writes/P7-26-approval-policy-page-only.md)** (design level; D-11 allowed elicitation, so a "page only" policy
per workspace or grant is an option for the owner). Documented as a residual in THREAT_MODEL T31.

**Q-2 — Agility-sourced text was validated as if the caller supplied it** — **fixed here.** Old values and `Name [OID]` labels with
hidden characters or over 8,000 characters made some items impossible to change (rename an item with a pasted zero-width space; update
an item with a long description; create under a parent whose title has one). The hash still binds the full old value; for display
(elicitation text, dry run, approval page) an old value is cleaned and shortened to 2,000 characters with a visible note, label names
are cleaned where the label is built, and the strict refusal stays for caller-supplied new values. This also removes the "item with a
description over about 20,000 characters cannot be updated" refusal (P-8). Decision D-192, lesson L-405.

**Q-3 — Emoji sequences and ZWNJ scripts were refused** — **fixed here.** A ZWNJ or ZWJ between two visible characters is allowed in
caller text; a lone one, one next to a space, two in a row and every other hidden or bidirectional character are still refused.
Decision D-193; tests for a family emoji, a profession emoji with a skin tone, Persian and Devanagari.

**Q-4 / Q-5 — The comment and effort "identical entry" no-ops had no time bound; the default effort date is the UTC day** — **fixed
here.** Both apply only within 10 minutes (comment: `AuthoredAt`; effort: `CreateDateUTC`); a time that cannot be read is not a
repeat; outside the window the write proceeds. An omitted effort `date` is the UTC day, now said in the argument and the description
(the caller's zone is unknown). Decision D-194. The hypothesis that Agility normalises comment text, which would defeat the comparison,
is on the sandbox list.

### Low

**S-L1 — The approval page showed the Agility title uncleaned and uncapped** — **fixed here** (the page stores the cleaned, capped title
and the display form of the mutation).

**S-L2 — Elicitation rounds and the hash were not bound to the workspace and instance** — **fixed here.** The sealed state and the
ledger round entry now carry the workspace (and the state the instance); both are checked before the round counts, so the THREAT_MODEL
sentence holds for every channel. Decision D-198, lesson L-407; tests for another workspace and another instance.

**S-L3 — Approval prompt spam and pending-list eviction** — **deferred to
[P7-27](../tasks/phase-7-writes/P7-27-approval-request-limits.md).**

**S-L4 — Create idempotency is best effort** — **not a defect** (documented limit of D-179: Agility has no atomic check; the approval,
the per-grant limit and the window make it rare). A per-process mutex for stdio is a possible later hardening.

**S-L5 — Overwriting tools advertised `destructiveHint: false`** — **fixed here.** `update_fields`, `update_status`, `move_to_sprint`
and `assign_owners` advertise `destructiveHint: true`; their kind stays `write`; the additive tools do not. Decision D-197.

**S-L6 / Q-11 — `update_fields` could erase formatting the approver cannot see** — **fixed here.** A description whose current HTML has
anything but paragraphs and line breaks is not replaced (refused before approval, with the reason); other fields of the item still
update. Decision D-196.

**S-L7 — Envelope look-alike rewriting in approval text** — **deferred to
[P7-29](../tasks/phase-7-writes/P7-29-envelope-lookalike-in-approval.md).**

**S-L8 — `rt.limiter` was optional** — **fixed here.** `WriteRuntime.limiter` is required; a host without one does not compile (a
`@ts-expect-error` test keeps it so; the test helper supplies a permissive limiter).

**S-L9, S-L10 — Owner names may be mis-paired with OIDs; comment text may render as HTML** — **sandbox** (hypotheses): added to the
P7-07 checklist, with the question whether `QuickClose` cascades.

**Q-7 — A refused limiter check spent the grant's unit** — **fixed here.** The deployment counter is read before the grant's unit is
taken, so a full deployment refuses without spending anything (a race of two calls can still leave one unit spent; said in D-198).
Decision D-198, lesson L-406; test: five refused calls leave the other grant's counter empty.

**Q-8 — The approval is consumed before later refusals** — **deferred to
[P7-28](../tasks/phase-7-writes/P7-28-approval-consumed-before-refusals.md)** (acceptable and documented for the limiter in D-157; the
dangling-intent note goes there too).

**Q-9 — Create duplicate check: unreadable time is "recent forever", zone-less `CreateDate` read as UTC** — **fixed here.** An
unreadable time is never recent; a time without a zone gets the widest zone skew (14 hours) so a repeat is not missed. Decision D-195.
Not done: returning a no-op that names the existing item instead of an error, and naming the created item in the summary (the OID is in
the structured result): suggestions, left.

**Q-10 — `assign_owners`: inactive members cannot be removed by name; a renamed member gives a false conflict** — **sandbox**
(hypotheses about what Agility returns), noted in the P7-07 checklist item for `assign_owners`.

**Tests that do not prove what the name says** (Q) — **partly fixed.** The hint test now goes through the real client and real error
shapes; the "too much text" case moved to the schema now that it advertises the same maximum; the fake writes a creation time on
efforts. Left: the `expect([A, B]).toContain(code)` assertions in the denied-type tables and the loop that only asserts a throw for bad
hours and dates (they pass for either of two valid refusals).

**Duplicated logic in the framework** (Q) — **not changed** (refactor, no defect): a shared target helper, a declarative re-read, the
type-allowed predicate. Worth doing with the next wave of tools.

### Performance and cost (P)

| # | Finding | Verdict |
|---|---|---|
| 1 | `pnpm bench:worker` fails (`allowNonRead` missing in the bench's registry) | **fixed in the performance PR** |
| 2 | D1 rows written per approved write; default deployment cap can exceed the Free daily budget | **fixed in the performance PR** (docs, Free-plan ceiling) |
| 3 | Two wasted `DELETE ... RETURNING` queries per confirmed call | **fixed in the performance PR** |
| 4 | Redundant round trips (limiter, outcome audit); my change adds one read to the limiter (D-198) | **performance PR** for the rest; the extra read is deliberate |
| 5 | `kv.list(prefix)` is a table scan on D1 | **fixed in the performance PR** |
| 6 | Declared costs tight for two tools, loose for two | **fixed in the performance PR** |
| 7 | Avoidable Agility requests (child counts, the `Member IsSelf` repeat) | **not changed** (headroom only; the performance PR owns costs) |
| 8 | An item with a very long description is refused as "too large to approve"; schema advertises 8,000, validator 4,000 | **fixed here** (old values shortened for display, D-192; schema maximum equals the validator's for descriptions and comments) |
| 9 | No write-path bench; docs drift ("largest declares 24") | **fixed in the performance PR** |
| 10 | `tools/list` grows by about 10.7 KB with writes on | **not a defect** (grants see only their tools; startup cost only) |

## What was found sound

- **Enablement:** server switch, workspace write policy, personal credential, OAuth `mcp:write`, both tool lists; re-checked inside the
  tool; `approval: off` exists only in stdio config; the registry refuses write tools not built by `defineWriteTool`.
- **Approval binding and replay:** the hash covers tool, actor, operation, target and every old and new value; ledger takes are atomic and
  single use; sealed state is HMAC-verified in constant time, size-capped, bound to hash, actor and expiry; a forged state falls through to
  a fresh ask; the approval page reads records only by the signed-in person's id and checks CSRF, Origin, fetch metadata and a recent
  sign-in.
- **No raw construction:** field, relation and operation names come from allowlists and metadata; values are escaped by the one XML
  builder; control characters and lone surrogates are refused; one POST per write, never retried, no redirects.
- **Scope:** targets, projects, parents and sprints resolve through the compiler's scope and are re-checked on the re-read; no tool can
  change Scope, Team or a parent (except on create under a scoped parent).
- **Limiter and audit:** fails closed on store errors and odd values; intent stored before the send and the write refused if it fails;
  audit rows hold field names, ids and the hash, never values.
- **Unbounded work** is capped everywhere (text, changes, members, child counts, pending approvals, in-memory ledgers).
- **Writes off cost nothing** per request, and startup shows no visible regression.

## Checks

`pnpm typecheck` clean; the write, limiter, pipeline, tool and approval-page tests pass (targeted runs); the full suite runs in CI.
Nothing was run against Agility.

## New work

| Id | What | Why |
|---|---|---|
| [P7-26](../tasks/phase-7-writes/P7-26-approval-policy-page-only.md) | Approval policy "page only" per workspace or grant | S-M3; owner decision on the default |
| [P7-27](../tasks/phase-7-writes/P7-27-approval-request-limits.md) | Limit approval prompts, no eviction of pending approvals | S-L3 |
| [P7-28](../tasks/phase-7-writes/P7-28-approval-consumed-before-refusals.md) | Do not burn an approval on a later refusal | Q-8 |
| [P7-29](../tasks/phase-7-writes/P7-29-envelope-lookalike-in-approval.md) | Approval text and the envelope phrase | S-L7 |

Decisions recorded: D-191 … D-198 in [phase-7.md](../pending-decisions/phase-7.md). Lessons: L-404 … L-407.
