---
id: P7-29
title: "Approval text: values that contain the envelope phrase"
phase: 7
status: done
priority: low
depends_on: [P7-02]
adr: ["0013"]
lessons: [L-106]
owner: ""
---

# P7-29 — Approval text: values that contain the envelope phrase

> Filed by the Phase 7 review ([P7-09](P7-09-phase-7-review.md)). Refined 2026-10-29 (lane A).

## Goal
`neutralise()` rewrites `untrusted data` to `untrusted~data` inside the approval, so a title or comment containing that phrase is shown differently from what is sent (review L7).

## Scope
- Refusing caller text that contains the phrase would block honest titles ("Handle untrusted data in the importer"), so the
  approval text writes the first letter of each look-alike (`untrusted data`, any case, with spaces, underscores or hyphens)
  as a JSON escape (`\u0075ntrusted data`). The values are already JSON-quoted, so this is the same text once read as JSON;
  `neutralise()` finds nothing left to rewrite and is not touched. One fixed line ("\uXXXX inside a quoted value stands for
  that exact character") is added only when an escape was used.
- Applies to every value in the elicitation text: old values, new values and the title. The approval page already shows
  `JSON.stringify` of the exact value (HTML-escaped) and needs no change; a test pins it.
- The hash still binds the real value; nothing is refused, so no caller-facing error changes.

## Acceptance criteria
- [x] What is read is what is sent for a value containing the phrase in each spelling (test: JSON-decoding the shown value
      gives the sent value; no `untrusted~data` in the text).
- [x] The envelope is not weakened: a forged closing marker inside a value is not a marker (test).
- [x] The page shows the same value (test).

## Security notes
THREAT_MODEL T31, A2, A13.

## Lessons applied
- L-106 — Show the whole change, never a summary.

## Docs to update
- docs/guide/write-tools.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
