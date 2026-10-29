---
id: P6-50
title: Sprint capacity where the instance holds capacity data
phase: 6
status: todo
priority: low
depends_on: [P6-17]
adr: ["0011"]
lessons: [L-033]
owner: ""
---

# P6-50 — Sprint capacity where the instance holds capacity data

## Goal
Answer "how much can the team take" from capacity data the instance really holds, never an estimate (D-83). Split out of
[P6-17](P6-17-sprint-capacity-velocity.md).

## Scope
- On an instance with capacity data (the read-only tenant has none), find where Agility keeps it and how it relates to a
  sprint and a team; record it in docs/RESEARCH.md.
- Report it in `get_sprint` or `get_velocity` only when read; otherwise say it is not reported.

## Acceptance criteria
- [ ] Capacity source verified on a real instance and recorded (shapes only).
- [ ] Capacity reported when present, absent with a note otherwise; tests on fixtures shaped like the verified data.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-033 — Never report a plausible number with no source.

## Docs to update
- docs/RESEARCH.md, docs/reference/tool-catalogue.md

## Out of scope
- Hour-based burndown (P6-49).
