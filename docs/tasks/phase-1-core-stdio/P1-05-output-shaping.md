---
id: P1-05
title: Output shaping v1 and untrusted-data envelope
phase: 1
status: review
priority: high
depends_on: [P1-01]
adr: ["0015"]
lessons: [L-018, L-033, L-038, L-039, L-040, L-041, L-043, L-144, L-149, L-166]
owner: "Matias Hidalgo"
---

# P1-05 — Output shaping v1 and untrusted-data envelope

## Goal
One shaper that turns every result into compact text, open `structuredContent` and `_meta`, with every Agility string inside an unforgeable untrusted-data envelope.

## Scope
- `shape(result)` → text summary, notes and data blocks; `structuredContent`; `_meta["agility-bridge/result"]`.
- Formats `auto`, `table`, `csv`, `json`; caps and truncation notices.
- Envelope with a random marker per call and neutralised look-alikes; warning line per block.
- HTML → text/Markdown conversion for rich text (drop scripts, styles, event attributes, `javascript:` links); control and bidi characters stripped.
- Identity columns, `partial` + `notes`, `nextCursor` / `truncated` / `total` (refined in P1-05: Agility's `-1` and
  uncomputed totals are omitted, never `null`, per ADR-0015 and the final conventions).
- Member email minimisation; CSV formula neutralisation; error rendering.

## Acceptance criteria
- [x] Snapshot tests per format.
- [x] Fuzz test: data cannot close or forge the envelope.
- [x] HTML conversion tests with `<script>`, `<style>`, `onerror=`, `javascript:` links and nested lists.
- [x] `structuredContent` holds exactly the rows the text shows, with the same cuts.

## Security notes
THREAT_MODEL T6, A1, A7.

## Lessons applied
- L-018 — Always return text and `structuredContent` together.
- L-033 — Never turn missing data into zeros or confident claims.
- L-038 — Everything that came from upstream is untrusted.
- L-039 — Make the envelope unforgeable.
- L-040 — Give agents compact output.
- L-041 — Neutralise spreadsheet formulas.
- L-043 — Keep identity on every row.
- L-144 — `total = -1` means "not computed".
- L-149 — Send UTC, read the UTC variants.
- L-166 — Build invisible characters from code points in tests.

## Docs to update
- docs/dev/tool-conventions.md
- docs/guide/output-formats.md (new)

## Out of scope
- MCP Apps views (P8-03)
