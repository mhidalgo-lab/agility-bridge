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

### D-346 — The residual risks R-1 to R-13 are accepted for 1.0 as written *(P9-01)*
- **Context:** The final threat-model review found no row without evidence, but thirteen limits cannot be removed (prompt injection, a client-answered elicitation, provider retention, approximate per-isolate limits, private CAs on Workers, a master-key holder, private instance addresses by default, a pass-through timing difference, full-delegation tokens, a one-TTL cache window, the App view's `'*'` post target, the release chain's trust in GitHub and npm, an opt-in public catalogue). They are listed in `docs/security/threat-evidence.md`.
- **Options:** (a) accept them as written and publish the register with 1.0; (b) accept all but turn some into work (for example padding the pass-through timing, R-8, or making `AB_INSTANCE_PRIVATE_ADDRESSES=refuse` the default, R-7); (c) hold 1.0 until the external review (P9-02) has seen the register.
- **Recommendation:** (a), built as (a). The external reviewer sees the register first, and anything it ranks higher becomes a task before 1.0. R-7 as a default stays an open product question, not a security defect, because on-premises instances need private addresses.

### D-347 — `fast-check` is a dev dependency of every package that has parser fuzz tests *(P9-01)*
- **Context:** Fuzz tests live next to the parser they test (`packages/http-app`, `apps/cli` as well as `core` and `auth`), and pnpm's strict layout needs the dependency declared where it is imported.
- **Options:** (a) declare `fast-check` (same pinned version) in each package that uses it; (b) move all fuzz tests to `packages/core/test` and import other packages' sources across the boundary; (c) a shared `test-utils` workspace package.
- **Recommendation:** (a), built as (a): no new package, no cross-package source imports, and Renovate updates all of them in one PR. It adds nothing to a published runtime dependency list (dev only).

### D-361 — The documentation site publishes `docs/` except the planning records *(P9-04)*
- **Context:** `docs/tasks/` (about 250 task files) and `docs/pending-decisions/` are working records for the maintainers and agents, not documentation for users; they would swamp the sidebar and the search results. Pages that link to them still need a working link.
- **Options:** (a) leave both out; links from site pages to them point at the file in the repository; (b) publish them in an "Internal" sidebar group; (c) publish everything.
- **Recommendation:** (a), built. Guides, reference, developer pages, security, the threat model, ADRs, research, phase reviews, the roadmap and the lessons are on the site; `tasks/` and `pending-decisions/` stay in the repository (`EXCLUDED_DIRS` in `scripts/docs-site.ts`). Revisit at 1.0, when the roadmap page may be the public face of planning.

### D-362 — The site is its own pnpm workspace, built by its own workflow *(P9-04)*
- **Context:** Starlight and Astro add about 280 packages. Putting `site/` in the root workspace would make every CI job install them and put them in the product lockfile.
- **Options:** (a) `site/` with its own `pnpm-workspace.yaml` and lockfile (same supply-chain settings), installed only by the docs-site workflow; (b) a package under `packages/` in the root workspace; (c) npm in `site/`.
- **Recommendation:** (a), built. The existing lint, typecheck, test and build jobs are unchanged; Renovate still sees `site/package.json`. The cost is one more lockfile to keep current, and Astro's image library (sharp) brings LGPL libvips binaries: dependency review allows those packages by name because they only run where the site is built and ship in nothing.

### D-363 — Deploy is skipped, with a warning, until Pages is enabled *(P9-04)*
- **Context:** The deploy action fails when Pages is not enabled with the GitHub Actions source, and that setting is the owner's to change. A red `main` would get in the way of other work.
- **Options:** (a) the build job asks the Pages API and the deploy job runs only when it is enabled; (b) `continue-on-error` on the deploy job (hides real deploy failures once Pages is on); (c) leave the workflow out until Pages is on.
- **Recommendation:** (a), built. The site is still built and link-checked on every change; deployment starts by itself after Settings, Pages, Source: GitHub Actions.

### D-364 — CI checks internal links and anchors; external links are not checked there *(P9-04)*
- **Context:** The task asks for broken internal links and anchors to fail CI. An external link check on every pull request would fail unrelated changes whenever a third-party site is down or rate-limits the runner.
- **Options:** (a) internal only on pull requests, plus a scheduled external check as a follow-up task (P9-19); (b) external links in the required path; (c) no external check.
- **Recommendation:** (a), built. `docs/` relative links and anchors run in `pnpm lint`; the built site's links and anchors fail the docs-site build.

### D-365 — The docs-site job is not a required check *(P9-04)*
- **Context:** The workflow is path-filtered (`docs/**`, `site/**`) so it does not run on code-only pull requests. A required check that never reports blocks those pull requests. The `docs/` link check that matters for every change also runs in `pnpm lint`, which is already required.
- **Options:** (a) keep "Build and link check" a non-required check, relying on `pnpm lint` for the docs links; (b) drop the path filter and make it required (about 40 s extra on every pull request); (c) require it with a ruleset that tolerates skipped checks.
- **Recommendation:** (a), built. Choose (b) if you want a broken site build to block merging; it is a ruleset change that is yours to make.
