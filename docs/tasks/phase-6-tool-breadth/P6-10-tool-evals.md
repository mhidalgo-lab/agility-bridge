---
id: P6-10
title: Tool evaluations
phase: 6
status: in-progress
priority: medium
depends_on: [P6-07]
adr: ["0015"]
lessons: [L-031, L-124]
owner: "claude (P6-10 agent)"
---

# P6-10 — Tool evaluations

## Goal
Check that agents pick the right tool and resist injected content.

## Scope
- **Description lint**: the existing naming/description/schema lints (`packages/core/test/harness/lint.ts`) stay the gate;
  the evals add no second linter, but a router miss that a description change fixes is fixed there.
- **Lexical router baseline** (deterministic, no network, in `pnpm test`): a committed dataset of realistic questions with
  invented names and numbers (`scripts/evals/dataset.json`), each with the acceptable tools; a scorer (BM25 over the
  names and descriptions of the exact `tools/list`); a committed baseline (`scripts/evals/baseline.json`); the test fails
  when top-1 or top-3 accuracy falls below it. Categories: find B-/S- items, defects in a project, my tasks, sprint
  status, quality review, and the Phase 6 tools (portfolio, sprint, history, conversations, attachments, reports),
  discovery and metadata, plus questions the generic tools must win.
- **LLM eval** (`pnpm eval:llm`, `scripts/eval-llm.ts`, never in CI or `pnpm test`): sends the exact `tools/list`
  (name, description, input schema) and the dataset to a Claude model, then replays hostile tool results (prompt
  injection in titles, descriptions, comments and attachment names, inside the real untrusted-data envelope) and checks
  the tool choice and that the injected instructions are not followed. Refuses to run without `ANTHROPIC_API_KEY` and an
  explicit `--yes`; the scoring is unit-tested with a stubbed model.
- **Release checklist**: the eval report is a step of `docs/dev/releasing.md`.
- Findings that defer to the evals (D-95, D-98 / P6-26, P6-28) get their evidence criteria written down in
  `docs/dev/evals.md`.

## Acceptance criteria
- [ ] Dataset of at least 60 questions over every category above, invented data only, every expected tool exists.
- [ ] Router scored over the exact `tools/list` (default catalogue for default-group questions, full catalogue for
      opt-in ones); baseline committed; CI fails below it; raising the baseline is a documented one-liner.
- [ ] Misses the router shows are triaged in `docs/dev/evals.md` (fixed in a description, or accepted with a reason).
- [ ] LLM harness: exact `tools/list`, hostile scenarios, tool-choice and injection scoring, refuses without a key and
      `--yes`, writes a Markdown report; scoring unit-tested with a stubbed model; not wired into CI or `pnpm test`.
- [ ] `docs/dev/evals.md` explains both evals, how to add a question and how the owner runs the LLM eval.
- [ ] Release checklist item for the eval report in `docs/dev/releasing.md`.
- [ ] **Owner:** the first real LLM run and the attached report (not run by the implementing agent: it spends money).

## Security notes
THREAT_MODEL A1.

## Lessons applied
- L-031 — Descriptions are prompts.
- L-124 — Evaluate tools the way an agent sees them.

## Docs to update
- docs/dev/evals.md (new)

## Out of scope
- Anything not listed under Scope.
