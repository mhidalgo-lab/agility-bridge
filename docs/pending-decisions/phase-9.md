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

### D-348 — Scorecard Code-Review and Branch-Protection stay low until there is a second reviewer *(P9-06)*
- **Context:** Scorecard scores `Code-Review` 0 (no approving review on any change) and `Branch-Protection` 4 (no required approvers, no code-owner review, no last-push approval). The cause is one maintainer merging after CI; a required approval would block every merge.
- **Options:** (a) accept the two scores and say why in `docs/security/scorecard.md`; revisit when a second maintainer exists; (b) require one approval and add a second account or a bot as reviewer now; (c) require code-owner review of the security-relevant paths only.
- **Recommendation:** (a), built as (a). A reviewer account that only clicks approve would raise the number and lower the meaning of review. The external review (P9-02) is the real second pair of eyes for 1.0.

### D-349 — The ASVS mapping is published as a self-assessment *(P9-06)*
- **Context:** `docs/security/asvs-l2.md` maps the 253 Level 1 and 2 requirements of ASVS 5.0.0 with evidence: 175 Met, 66 N/A with a reason, 5 Delegated to the platform or operator, 7 Partly (task P9-09), 0 Gap. No assessor has reviewed it.
- **Options:** (a) publish it as a self-assessment and say so on the page and in the 1.0 notes; (b) hold it until the external reviewer has checked it; (c) do not publish a mapping.
- **Recommendation:** (a), built as (a). The page states that it is not a certification, and the test that reads it keeps it from drifting. Ask the external reviewer to challenge it (it is in the call for reviewers).

### D-350 — An admin may switch an instance back on after an owner switched it off *(P9-02)*
- **Context:** The internal pre-review found that `PATCH /instances/{id}` with `disabledAt: null` is open to admins, so a kill switch pulled by an owner can be undone by a lower role. The current design (and an existing test) gives admins add, rename, disable, enable and delete of instances; only an instance's origin and TLS trust are owner-only.
- **Options:** (a) keep it and document it (admins are trusted managers of instances); (b) require an owner with a recent sign-in to re-enable a disabled instance; (c) record who disabled it and let only the same or a higher role re-enable.
- **Recommendation:** (a), built as (a): nothing was changed, the pre-review lists it and P9-10 holds (b) if you decide otherwise. An admin who can already delete an instance and add another gains nothing real from the re-enable, and a role that cannot undo its own team's mistakes is a worse default.

### D-351 — Coordinated disclosure window of 90 days *(P9-02)*
- **Context:** The call for reviewers and SECURITY.md needed a disclosure term. Reviewers and reporters ask for one; none was stated.
- **Options:** (a) 90 days from the report, or until a fixed release is out, whichever is first, and another time by agreement; (b) 45 days; (c) no fixed term.
- **Recommendation:** (a), built as (a): the common industry default, and long enough for a volunteer-maintained project to fix, release and let users upgrade. SECURITY.md already commits to 30 days for a fix of high and critical issues.

### D-356 — The budget and cap presets stay as they are after the P9-03 measurements *(P9-03)*
- **Context:** P9-03 measured every read tool on Node stdio, Node HTTP and a Free-plan Worker (mock upstream): no tool exceeds its declared cost, warm calls are 0 to 5 Agility requests, and the Worker's CPU is driven by a fixed per-request cost of 6 to 9 ms, not by response size.
- **Options:** (a) keep Free 45 requests / 512 KiB and Paid 1,000 / 8 MiB; (b) lower the Free response cap to cut CPU; (c) raise the Free budget now that warm calls are small.
- **Recommendation:** (a), built (no change). A lower cap would not move the fixed cost; a higher budget would not unhide the two reports (their declared cost is 54 and 48), and the headroom under 50 subrequests is what the Free plan allows.

### D-357 — Declared costs of `sprint_health` (54) and `standup_summary` (48) stay until a paging worst case proves a bound *(P9-03)*
- **Context:** Measured cold on the cost world they use 23 and 21 requests, so the Free budget of 45 hides them behind headroom that may be unnecessary. The cost fixture has no paging, so it is not a proof of the worst case (L-114).
- **Options:** (a) keep the declared costs and file the proof as P9-16; (b) lower them to the measured values plus a margin now; (c) make the reports degrade (fewer sections) on a small budget instead of hiding them.
- **Recommendation:** (a), built (no change). A declared cost that is too low breaks the guarantee that a call never needs a request the budget does not have; (c) is a product change that needs its own decision.

### D-358 — Warm CPU above 10 ms on Workers Free stays a documented tolerance, with a task to cut the fixed cost *(P9-03)*
- **Context:** 33% of 469 warm calls reported more than 10 ms of CPU on the Free plan and none failed (RESEARCH, 2026-11-03). This extends D-27 from the first request of an isolate to warm calls. Cloudflare may start enforcing the limit.
- **Options:** (a) keep Free supported as a tolerance, say so in the guide, and file P9-15 to profile and cut the fixed per-request cost; (b) declare Free "light use" and require Paid for teams; (c) make the Free plan refuse tools whose measured p50 is above 10 ms.
- **Recommendation:** (a), built. (c) would hide most tools on a plan that serves them today; (b) can follow if enforcement starts or P9-15 finds nothing to cut.

### D-359 — D1 rows for reads are documented as the Free plan's real ceiling; no default changes *(P9-03)*
- **Context:** A read tool call writes about 4 D1 rows (measured), so a read-only deployment on Free is bounded at about 24,000 tool calls a day by the 100,000 row limit, below the Worker request limit. The read audit row is the main part.
- **Options:** (a) document the ceiling and file P9-17 (attribute and reduce rows per read call, for example sampling or batching read audit rows); (b) stop auditing reads on Free; (c) leave it undocumented.
- **Recommendation:** (a), built. The audit log of reads is a feature owners rely on (usage statistics), so it is not turned off to save rows without a design.

### D-360 — Request regressions are pinned by a required unit test, CPU stays in the non-required bench job *(P9-03)*
- **Context:** Requests per tool are exact; CPU is noisy on shared runners (the baseline compares ratios and flags at 2x). The bench job is not a required check.
- **Options:** (a) a unit test (required, in `pnpm test`) pins every read tool's cold and warm requests to the baseline and its cold count under the declared cost, and the bench job also flags request growth; CPU stays a 2x ratio warning; (b) make the bench job itself required; (c) pin only declared costs (already in the cost test).
- **Recommendation:** (a), built. (b) would make an unreliable timing job block merges; (c) misses a tool that gets more expensive but stays under its declaration.
