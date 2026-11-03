# Pending decisions — Phase 9

> Open questions and owner steps from Phase 9 (hardening and launch). Answer inline (`**Owner:** …` with a date).

> The owner authorised the whole phase as a batch (2026-11-03): decisions are built at their recommendation; say so if
> you want the alternative.

## Decisions

### D-366 — Security support window for 1.x *(P9-05)*
- **Context:** Pre-1.0 only the latest minor gets fixes. A 1.x line needs a stated window; the backport path (`release/x.y`, P9-07) makes a second line possible.
- **Options:** (a) the latest minor plus the previous minor for 90 days after a new minor; (b) latest minor only, always; (c) the latest minor plus the last minor of the previous major for 12 months.
- **Recommendation:** (a), published in `docs/guide/versioning.md` and SECURITY.md. A volunteer-maintained project can carry one extra line for a short overlap; (b) forces upgrades on every minor; (c) is a promise the project cannot yet afford.

### D-367 — No promised minimum on-premises Agility version *(P9-05)*
- **Context:** Hosted Agility is verified on 26.0.3.2. Which on-premises builds support `query.v1` and the metadata we rely on is unknown without a tenant (P0-06 left it open).
- **Options:** (a) promise no minimum, mark on-premises best effort and *unverified*, until someone tests an older build; (b) promise the oldest build documented by Digital.ai without testing; (c) refuse to start below a version.
- **Recommendation:** (a). A promise nobody tested is worse than none; `doctor` already probes the instance, and a tested minimum can be added in a minor release.
