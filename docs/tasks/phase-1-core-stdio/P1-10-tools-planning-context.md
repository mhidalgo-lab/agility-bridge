---
id: P1-10
title: "Tools: list_teams, get_team, list_sprints, list_members"
phase: 1
status: review
priority: medium
depends_on: [P1-06, P1-08]
adr: ["0015"]
lessons: [L-036, L-038, L-061]
owner: "Matias Hidalgo"
---

# P1-10 — Tools: list_teams, get_team, list_sprints, list_members

## Goal
Give agents the planning context — teams, people and sprints — without exposing more personal data than needed.

## Scope
- `list_teams`, `get_team` (members as the instance exposes them, per the P0-06 finding: team-room participants, a roster, or derived from assignments — and labelled as such), `list_sprints` (with `current`/`previous`/`next`), `list_members`.
- Member emails only when the workspace enables them; no avatars.

## Acceptance criteria
- [x] Fixture tests for teams with their own workflows and for sprint resolution.
- [x] Emails absent by default and present only with the workspace switch.

## Security notes
THREAT_MODEL A7.

## Lessons applied
- L-036 — Name resolution must expose ambiguity.
- L-038 — Everything that came from upstream is untrusted.
- L-061 — One time model for the whole server.

## Docs to update
- docs/reference/tool-catalogue.md

## Out of scope
- Anything not listed under Scope.
