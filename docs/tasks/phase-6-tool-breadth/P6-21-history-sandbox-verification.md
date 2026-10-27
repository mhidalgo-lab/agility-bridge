---
id: P6-21
title: Verify history against known edits on the writable sandbox
phase: 6
status: todo
priority: medium
depends_on: [P6-05, P7-07]
adr: ["0011"]
lessons: [L-146, L-284]
owner: ""
---

# P6-21 — Verify history against known edits on the writable sandbox

## Goal
Close the gap P6-05 could not: prove that `get_asset_history` reports exactly the edits somebody made, in order, with the
right author and time, and decide whether the activity stream is worth a labelled hint (D-89).

## Scope
- On the writable sandbox (P7-07): make a known sequence of edits to one work item (rename, status, owner add and remove,
  estimate, sprint move) and compare `get_asset_history` row by row with the edits (field, from, to, author, time within a
  few seconds).
- Record whether `rest-1.v1/Hist` accepts a date `where`/`filter` on the request (it would let the tool narrow the
  response, D-90) and what a version of a deleted or moved asset looks like.
- Probe `api/ActivityStream` once on the sandbox: shape, whether it covers the same edits, how often it misses one
  (L-146). Widen the live guard to it only if the owner decides on D-89 (b).
- Evidence in the template of `docs/dev/verification.md`, with asset numbers (sandbox only).

## Acceptance criteria
- [ ] The edit sequence and the history rows match, or every difference is explained and recorded in RESEARCH §1.4.
- [ ] The `Hist` date-narrowing question is answered in RESEARCH (*live*, dated).
- [ ] D-89 is answered from the activity-stream probe, or the probe is recorded as not run, with the reason.

## Security notes
Sandbox only; no tenant content from the third-party tenant is used or recorded.

## Lessons applied
- L-146 — The activity stream is not authoritative.
- L-284 — A history diff needs the version before the window.

## Docs to update
- docs/RESEARCH.md, docs/dev/verification.md

## Out of scope
- Any write tool; changes to the tools unless the comparison finds a defect (then a fix in this task).
