# Pending decisions — Phase 1

> Open questions and owner steps from the Phase 1 review ([review](../reviews/phase-1-review.md)). Answer inline
> (`**Owner:** …` with a date).

## Owner steps

1. **Approve the `live` workflow run on `main`** (Actions → Live → the waiting run → Review deployments), so the live
   suite has a CI run from `main` (P1-12). It is read-only and prints nothing from the tenant.
2. **Run the client snippets** of [client setup](../guide/clients.md) in VS Code, Claude Code, Copilot CLI and JetBrains
   against v0.1 (before publishing: `node apps/cli/dist/index.mjs`; to avoid the tenant, `node scripts/fixture-agility.ts`
   and point `AB_AGILITY_URL` at the URL it prints), and note client version, date and result (P1-14).
3. **Release set-up** ([releasing](../dev/releasing.md)): the npm trusted publisher with stage publishing only,
   "require 2FA and disallow tokens", the `release` environment with yourself as reviewer, then
   `AB_RELEASE_ENABLED=true`; approve the deployment, then approve the staged `0.1.0` with 2FA on npmjs.com (P1-15).

## Open decisions

### D-20 — Nightly live run *(P1-12)*
- **Options:** keep the live suite on demand; schedule it nightly (each run waits for the `live` environment approval);
  schedule it nightly with the approval rule relaxed for the schedule.
- **Recommendation:** keep it on demand and run it before every release and phase review: the tenant belongs to a third
  party, and an approval prompt every night trains people to click through it.

### D-21 — Go for Phase 2 *(P1-16)*
- **Options:** go now; go after v0.1 is published and the clients are verified.
- **Recommendation:** go after v0.1 is published and the four client runs are recorded.
