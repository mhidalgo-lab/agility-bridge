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
   **Done 2026-10-21:** `agility-bridge@0.1.0` and the GitHub Release `v0.1.0` are published.

## Open decisions

### D-20 — Nightly live run *(P1-12)*
- **Options:** keep the live suite on demand; schedule it nightly (each run waits for the `live` environment approval);
  schedule it nightly with the approval rule relaxed for the schedule.
- **Recommendation:** keep it on demand and run it before every release and phase review: the tenant belongs to a third
  party, and an approval prompt every night trains people to click through it.
- **Owner (2026-10-21):** Decided: on demand, no nightly live run.

### D-21 — Go for Phase 2 *(P1-16)*
- **Options:** go now; go after v0.1 is published and the clients are verified.
- **Recommendation:** go after v0.1 is published and the four client runs are recorded.
- **Owner (2026-10-21):** Decided: go. v0.1.0 is published; the client runs (P1-14) follow after the release.

### D-123 — Where a plain date attribute is answered *(P1-19)*
- **Context:** `ChangeDate` and `CreateDate` are zone-less local time; the `…UTC` siblings are UTC (live, 2026-10-26).
- **Options:** (a) read the `…UTC` sibling and return it under the key the caller asked for; (b) answer under the `…UTC` key with a note; (c) leave the raw value and only note it.
- **Recommendation:** (a): the caller gets what they asked for, in the contract format, and filters and sorts follow the same rule.
- **Owner (2026-10-29):** Decided: as recommended, (a).
