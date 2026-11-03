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

### D-368 — Only the owner creates `release/x.y` branches *(P9-07)*
- **Context:** `Protect release/*` blocks deletion, force pushes and unreviewed changes, but anyone with write access can still create a `release/*` branch from any commit; the `release` environment approval and the version/line checks are the only brake.
- **Options:** (a) add "Restrict creations" to the ruleset with the owner as the only bypass actor; (b) keep as is and rely on the approvals; (c) a CODEOWNERS-style team once there is a second maintainer.
- **Recommendation:** (a) when the owner next touches the settings; it costs nothing because backport branches are rare. Settings are written in `docs/security/repo-settings.md` and left unchecked.

### D-369 — The backport dry run is local; a dispatch dry-run mode is a follow-up *(P9-07)*
- **Context:** A backport cannot be rehearsed in Actions without pushing a `release/*` branch, which the brief and the rulesets rule out. A local run covers `plan`, versioning, build, package check and image tags, but not OIDC, attestation or GHCR steps.
- **Options:** (a) document and execute the local dry run now, track a `workflow_dispatch` dry-run mode and an ancestry guard as P9-23; (b) add the dispatch mode now; (c) rehearse on a throwaway fork.
- **Recommendation:** (a), built. Changing the release workflow's inputs deserves its own reviewed PR; (c) would need its own npm package and trusted publisher.

### D-370 — `cosign` is not part of the verification guide *(P9-07)*
- **Context:** `gh attestation verify` verifies the provenance and SBOM attestations of tarball, checksums and image, and was run against 0.8.0. `cosign` is not installed on the maintainer's machine, so cosign commands could not be tested (L-133).
- **Options:** (a) document only `gh attestation verify` and say so; (b) add untested cosign commands marked *unverified*; (c) install cosign and document it.
- **Recommendation:** (a). Add cosign when someone runs it against a release and records the result.

### D-371 — A release refuses a version older than one already on npm in its line *(P9-07)*
- **Context:** The image tags and dist-tags never move backwards (L-128), but `plan` accepted publishing `1.2.3` after `1.2.4` existed if `1.2.3` itself was unpublished (for example a mis-versioned backport).
- **Options:** (a) `plan` fails when a higher stable version of the same `major.minor` is on npm; (b) leave it to review; (c) forbid all out-of-order publishes across lines.
- **Recommendation:** (a), built. Different lines legitimately publish out of global order (a `0.8.x` fix after `0.9.0`), so the check is per line.
