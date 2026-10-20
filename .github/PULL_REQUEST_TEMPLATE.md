## Task

<!-- e.g. P1-04 — link to docs/tasks/...md. One task per branch and PR. -->

## What changed and why

## Checklist (definition of done, AGENTS.md)

- [ ] Task file updated: acceptance criteria ticked, `status: review`, ROADMAP index refreshed
- [ ] Tests added or updated, including **negative authorization tests** for every new route or tool (no upstream call and no data on denial)
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass; generated references refreshed
- [ ] Docs listed under *Docs to update* changed, and documented commands still run
- [ ] Security-relevant change → `docs/THREAT_MODEL.md` updated in this PR
- [ ] New lesson (review finding, live-test surprise, client quirk) → `docs/LESSONS-LEARNED.md` updated
- [ ] No secrets (Agility tokens, `ab_` tokens, master key, admin tokens, cookies) and no real Agility data in code, fixtures, logs or screenshots
- [ ] Changeset added if the published `agility-bridge` package changed
- [ ] Conventional Commits with the task id, every commit signed off (DCO, `git commit -s`)
