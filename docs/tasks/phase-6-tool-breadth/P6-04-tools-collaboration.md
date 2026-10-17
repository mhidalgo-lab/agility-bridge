---
id: P6-04
title: Collaboration tools (conversations, links, attachment metadata)
phase: 6
status: todo
priority: medium
depends_on: [P2-17]
adr: ["0015"]
lessons: [L-038, L-056]
owner: ""
---

# P6-04 — Collaboration tools (conversations, links, attachment metadata)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Read the discussion around a work item safely.

## Scope
- `get_conversations` (comments newest first, paged, enveloped) and `list_attachments` (metadata only; no download in 1.0, THREAT_MODEL A8); external links listed as text.

## Acceptance criteria
- [ ] Poisoned comments and attachment names stay inside the envelope; no attachment content is fetched.

## Security notes
THREAT_MODEL A1, A8.

## Lessons applied
- L-038 — Everything that came from upstream is untrusted.
- L-056 — Reads never create public links.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
