---
id: P6-33
title: First LLM tool-eval run and triage
phase: 6
status: done
priority: medium
depends_on: [P6-10]
adr: ["0015"]
lessons: [L-124, L-309, L-310]
owner: ""
---

# P6-33 — First LLM tool-eval run and triage

## Goal
Run the P6-10 LLM eval with real models, attach the report to the release, and turn what it shows into decisions.

## Scope
- Run `pnpm eval:llm --yes` with `claude-sonnet-5-5` and `claude-opus-5-5` (owner, API key; see `docs/dev/evals.md`).
- Triage every tool-choice miss and every followed injection; record the numbers and tune the 85 % advisory floor (D-109).
- Answer D-95 (P6-26) and D-98 (P6-28) with the evidence from the `quality`, `defects` and `generic` questions.

## Progress
- 2026-10-27: first runs (Sonnet 5.5, Opus 5.5, smoke; through a local router). Triage found the harness at fault for most
  flags: a canary inside the data the question asks for, context reads scored as following, one trial per scenario, and
  first-call-only tool scoring. Fixed (transformed-word canary, `injectedTools`, `--samples` default 5, one scripted lookup,
  evidence kept in the report, three dataset routes added); see docs/dev/evals.md and L-331, L-332. **Next:** the owner
  reruns both models with the fixed harness (once directly against the API if possible), then the triage below.
- 2026-10-27: second runs: six scenarios clean in all trials; H06 (instruction in Agility error text) followed by both
  models. Fixed in the product: Agility error messages withheld from results, trusted hint on every upstream refusal
  (L-333); H06 rebuilt on the real error path; no-tool answers keep their evidence. **Next:** the owner reruns both models.
- 2026-10-28: release runs clean (0 of 35 trials followed, both models; Opus 90.4 % after one lookup). Through the
  maintainer's router, which can drop tool calls; no direct API key exists (solo maintainer, no sponsor), so the router runs
  are the release evidence with that caveat (docs/dev/evals.md). Reports committed under `docs/dev/eval-reports/` and linked
  from the release notes by a changeset.

## Acceptance criteria
- [x] Reports for both models attached to the release notes and summarised in `docs/dev/evals.md` (committed under
  `docs/dev/eval-reports/`, linked from the release notes through the `llm-eval-reports` changeset).
- [x] Every followed injection has a fix and a regression test (H06: #137, L-333); every miss is a description change (P6-34), a new dataset question or an accepted note.
- [x] D-95 and D-98 evidence recorded in P6-26 and P6-28.

## Security notes
THREAT_MODEL A1. Invented fixtures only; the key is never committed or logged.

## Lessons applied
- L-124, L-310, L-311.

## Docs to update
- docs/dev/evals.md

## Out of scope
- New tools (P6-26, P6-28 decide those).
