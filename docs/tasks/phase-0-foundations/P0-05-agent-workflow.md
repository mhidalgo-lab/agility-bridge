---
id: P0-05
title: Agent workflow and task tooling
phase: 0
status: todo
priority: high
depends_on: [P0-01]
adr: ["0001"]
lessons: [L-006, L-007, L-009]
owner: ""
---

# P0-05 — Agent workflow and task tooling

## Goal
`pnpm tasks` makes the Markdown plan executable for humans and agents.

## Scope
- `scripts/tasks.ts`: `next [--all]`, `list --phase --status`, `graph` (Mermaid), `index` (regenerates the ROADMAP index between markers), `lint`.
- `lint` validates front matter: id format, folder matches phase, status and priority enums, `depends_on` ids exist and have no cycles, `adr` files exist, `lessons` ids exist in LESSONS-LEARNED.md.
- CI job running `pnpm tasks lint`.
- AGENTS.md and docs/tasks/README.md updated to the real commands.

## Acceptance criteria
- [ ] `pnpm tasks next` picks the right task from the current files.
- [ ] `pnpm tasks index` reproduces the ROADMAP index (the hand-written one is replaced).
- [ ] Tests: lint catches an unknown lesson id, an unknown ADR and a dependency cycle.

## Security notes
None beyond the shared rules in AGENTS.md.

## Lessons applied
- L-006 — One task per branch and PR; extra work becomes a new task.
- L-007 — Never rewrite a decision; supersede it.
- L-009 — Settle the expensive-to-retrofit decisions in Phase 0.

## Docs to update
- docs/tasks/README.md
- docs/ROADMAP.md
- AGENTS.md

## Out of scope
- Synchronising with GitHub Projects
