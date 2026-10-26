---
id: P1-19
title: Return every date as UTC, including the non-UTC attribute variants
phase: 1
status: todo
priority: medium
depends_on: [P1-16]
adr: ["0015"]
lessons: [L-149]
owner: ""
---

# P1-19 — Return every date as UTC, including the non-UTC attribute variants

## Goal
The same instant reads the same on every tool. Today a caller who asks for `ChangeDate` or `CreateDate` by name gets a
zone-less local time that looks like UTC but is hours off. The tool conventions promise ISO 8601 UTC timestamps (L-149).

## Findings (live use, 2026-10-26)
- The same change event came back in two shapes (values illustrative, offset as observed). `get_work_item` returned
  `changedAt: "2026-10-01T16:00:00.000Z"`. `query_assets` and `get_assets`, with `ChangeDate` requested explicitly,
  returned `ChangeDate: "2026-10-01T05:00:00.0000000"`. That is an 11-hour gap. `CreateDate` also came back with no
  zone.
- Cause: `get_work_item` and the default field tiers read `ChangeDateUTC` / `CreateDateUTC`
  (`packages/core/src/tools/work/items.ts`, `packages/core/src/metadata/service.ts`). An explicitly requested
  `ChangeDate` / `CreateDate` is a `Date` attribute whose value has no zone, so `utcIso` returns `undefined` and
  `packages/core/src/tools/query/rows.ts` passes the raw value through. That raw passthrough is the documented "keep
  the raw value instead of guessing" behavior, but nothing in the output tells the caller that the value is not UTC.
  An agent reading it will treat it as UTC.
- This is live evidence for the open question in RESEARCH.md ("`ChangeDate`/`ChangeDateUTC`-style pairs exist, and
  the semantic difference is not documented"): the plain variant is a zone-less local time and the `…UTC` variant is
  UTC. Which zone the local time uses (server, instance setting or user preference) is *unverified*.
- `get_work_item` selects `CreateDateUTC` (`packages/core/src/tools/work/get-item.ts`) but its output has no
  `createdAt`, even though `createdAt` is a documented output key.

## Scope
- When a caller selects a plain date attribute (`ChangeDate`, `CreateDate`, `ClosedDate`, …) and the type has a
  `…UTC` sibling, read the sibling and return the UTC value. Either keep the requested key or answer under the `…UTC`
  key with a note; decide which and document it.
- A date attribute with no `…UTC` sibling whose value has no zone is still never guessed. It is returned with a
  per-result note saying it is local time with an unknown zone, so the caller cannot mistake it for UTC.
- Apply the same rule to filters and sorts on plain date attributes, so a `ChangeDate ge <UTC instant>` filter compares
  against UTC and not local time.
- `get_work_item` emits `createdAt` (UTC) from `CreateDateUTC`.
- Verify live which zone the plain variant uses, and record the answer in RESEARCH.md.

## Acceptance criteria
- [ ] `query_assets` and `get_assets` with `fields: ["ChangeDate", "CreateDate"]` return the same UTC instants as
      `get_work_item` for the same asset (unit test plus one live check).
- [ ] A zone-less date with no `…UTC` sibling is returned raw with a note; `utcIso` still never guesses a zone.
- [ ] A filter on `ChangeDate` with a UTC bound selects the same rows as the same filter on `ChangeDateUTC`.
- [ ] `get_work_item` output includes `createdAt` in ISO 8601 UTC.
- [ ] RESEARCH.md records the live finding with the date and marks the local zone's origin as verified or *unverified*.

## Security notes
None. Read-only output normalization, and no caller value reaches Agility outside the existing bound-parameter path.

## Lessons applied
- L-149 — Send UTC, read the UTC variants. Extend it from the default tiers to caller-selected fields, and add a new
  lesson if the live check shows something more specific.

## Docs to update
- docs/dev/tool-conventions.md (Timestamps)
- docs/RESEARCH.md (Dates)
- docs/LESSONS-LEARNED.md (L-149 or a new lesson)

## Out of scope
- Converting `as_of` or `time_range` inputs; they already take UTC.
- Showing times in the caller's local zone.
