# ADR-0001 — Markdown files for decisions and tasks

- **Status:** accepted (owner, 2026-10-16)
- **Date:** 2026-10-16
- **Related:** [tasks/README.md](../tasks/README.md), L-006, L-007, L-009

## Context

agility-bridge is planned and built largely with AI coding agents, reviewed by humans. Agents work best when the full
context of a decision or a task is in the repository, readable in one pass and versioned with the code it describes.
Issue trackers fragment that context across comments, labels and boards, and are awkward for agents to read and update.

## Decision

- **Tasks** are Markdown files under `docs/tasks/phase-N-*/`, one file per unit of work, with YAML front matter (`id`,
  `status`, `priority`, `depends_on`, `adr`, `lessons`, `owner`). The file is the single source of truth for status.
- **Decisions** are ADRs under `docs/adr/` (MADR-lite), numbered and never renumbered. A changed decision gets a new ADR
  that supersedes the old one.
- **Lessons** are numbered entries in `docs/LESSONS-LEARNED.md`; tasks cite the ones they apply.
- **Open owner questions** live in `docs/pending-decisions/` with options and a recommendation.
- GitHub Issues are for bug reports and feature requests from users; accepted work is turned into task files.
- A small `pnpm tasks` tool (P0-05) lists, picks, graphs and indexes tasks and validates front matter in CI.

## Consequences

- Plans are reviewable in PRs and diffable; the roadmap index is generated from front matter.
- Status changes are commits, so work in progress is visible in branches.
- Contributors must learn the task conventions; the template and CI validation keep files consistent.

## Alternatives considered

- **GitHub Issues/Projects as the plan:** rejected as the primary plan (context fragmentation, poor agent ergonomics);
  still used for intake.
- **A single planning document:** rejected; it does not scale to hundreds of tasks and creates merge conflicts.
