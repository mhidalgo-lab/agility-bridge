---
id: P6-20
title: Ranged reads of long attachment text
phase: 6
status: done
priority: low
depends_on: [P6-04]
adr: ["0015"]
lessons: [L-040]
owner: ""
---

# P6-20 — Ranged reads of long attachment text

## Goal
Let an agent read an attachment that is longer than one result (up to the download cap) in steps, without raising the
size of a single result (D-88).

## Scope
- `get_attachment` takes `offset_characters` alongside `max_characters`, returns `nextOffset` when text remains, and
  says the total length; the download is fetched again for each step (the bridge keeps no content between calls).
- Each step is a download: budgeted and audited like the first.

## Acceptance criteria
- [x] Reading a long text in steps returns every character once, with no overlap and no gap, and the last step has no
      `nextOffset`.
- [x] An offset past the end is an input error; every step stays inside the envelope and the size cap.
- [x] The tool description and the generated reference say that each step is a download.

## Security notes
THREAT_MODEL A8: no cached content, every step re-checks scope, type and size.

## Lessons applied
- L-040 — compact output with a way to get the rest.

## Docs to update
- docs/reference/tools.md (generated), docs/reference/tool-catalogue.md.

## Out of scope
- Caching downloaded content, searching inside attachments.
