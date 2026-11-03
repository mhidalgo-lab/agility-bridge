# Launch checklist for 1.0.0

> P9-08, draft of 2026-11-03. **Not signed off.** One list of every gate for 1.0: a ticked item links its evidence, an
> unticked item says who closes it. The owner signs off at the end, then cuts 1.0.0 with the steps under
> [Cutting 1.0.0](#cutting-100). Status of each task: `pnpm tasks list --phase 9`.

Legend: **[x]** done, with evidence · **[ ]** open · *owner:* only the owner (or a person the owner picks) can close it ·
*live:* needs a live Agility tenant, the writable sandbox or a real client.

## 1. Scope and freeze

- [ ] *owner, live:* Phase 8 review closed and the feature freeze for 1.0 declared
      ([P8-12](../tasks/phase-8-power-features/P8-12-phase-8-review.md); the review itself is
      [phase-8-review.md](../reviews/phase-8-review.md), the live pass and client re-check are open). Phase 9 started with
      this dependency waived by the owner on 2026-11-03.
- [ ] *owner:* v0.9.0 released: the Version Packages PR (#239) is the last 0.x release before 1.0 and carries the Phase 9
      changes so far.
- [ ] Every open decision in [pending-decisions/phase-9.md](../pending-decisions/phase-9.md) answered (D-346 to D-351,
      D-356 to D-371; D-366, the 1.x security support window, blocks 1.0 because the policy promises it).
- [ ] No `todo` task of priority **high** left in any phase, or each one moved out of 1.0 by a decision
      (`pnpm tasks list --status todo`).

## 2. Functionality

- [x] Read tools, reports, prompts and resources: generated reference in [tools.md](../reference/tools.md),
      [prompts.md](../reference/prompts.md), [resources.md](../reference/resources.md); request counts pinned by a
      required test ([performance.md](../reference/performance.md), P9-03).
- [x] Deployment modes: local stdio, `serve` (Node, Docker) and the Cloudflare Worker, each with a quickstart
      ([local](../guide/quickstart-local.md), [remote](../guide/quickstart-remote.md),
      [Cloudflare](../guide/cloudflare-deploy.md)) and CI on Node 24 and 26, macOS and Windows.
- [ ] *owner, live:* the live pass against a real tenant: every read tool, paging, deep links (threat evidence L-6) and
      attachments (L-10), recorded in [verification.md](verification.md).
- [ ] *owner, live:* writes verified in the writable sandbox
      ([P7-07](../tasks/phase-7-writes/P7-07-sandbox-write-verification.md); threat evidence L-9). Until then the
      [write tools guide](../guide/write-tools.md) keeps its "What is unverified" list, and 1.0 either waits or ships writes
      marked as such (decide in §1).
- [ ] *owner:* performance on a live tenant and on a Paid account
      ([P9-03](../tasks/phase-9-hardening-launch/P9-03-performance-cost.md); numbers today use a mock upstream with a
      latency model from the P0-06 live figures).

## 3. Real-client matrix

The matrix and the per-client checklist are in [client-compatibility.md](../reference/client-compatibility.md#verification-checklist-per-client-and-release).

- [x] Verified on 0.x builds (2026-10-20 to 2026-10-26): Copilot CLI, Copilot in VS Code, Copilot in JetBrains, Claude
      Code (stdio, HTTP and remote on Workers), MCP Inspector; OAuth with Claude Code, VS Code and MCP Inspector
      ([Verified so far](../reference/client-compatibility.md#verified-so-far)).
- [ ] *owner, live:* the per-client checklist re-run on the 1.0 release candidate for every primary client, with the
      client versions recorded.
- [ ] *owner, live:* OAuth with claude.ai web and Claude mobile (threat evidence L-3, L-4).
- [ ] *owner, live:* write approval through each client's channel (stdio elicitation, 2026-07-28 HTTP, the approval page).
- [ ] *owner, live:* MCP Apps views in a client that supports them
      ([P8-19](../tasks/phase-8-power-features/P8-19-verify-apps-in-real-clients.md); L-7).

## 4. Security evidence

- [x] Threat model evidence map: every T and A row mapped to code and tests, checked by a test
      ([threat-evidence.md](../security/threat-evidence.md), P9-01).
- [x] OWASP ASVS 5.0.0 Level 1 and 2 self-assessment, checked by a test ([asvs-l2.md](../security/asvs-l2.md), P9-06).
- [x] OpenSSF Best Practices **passing** badge (project 16294, 2026-11-03,
      [answers](../security/best-practices-answers.md)); Scorecard triaged ([scorecard.md](../security/scorecard.md)).
- [x] Internal pre-review of the riskiest areas ([phase-9-pre-review.md](../reviews/phase-9-pre-review.md), P9-02).
- [ ] *owner:* residual risks R-1 to R-13 accepted (D-346).
- [ ] *owner:* external security review done with the [call for reviewers](../security/call-for-reviewers.md); every
      finding fixed with a regression test or accepted; summary published
      ([P9-02](../tasks/phase-9-hardening-launch/P9-02-external-review.md)).
- [ ] The partly met ASVS rows closed or accepted ([P9-09](../tasks/phase-9-hardening-launch/P9-09-asvs-partial-rows.md)).
- [ ] No open code-scanning, Dependabot or secret-scanning alert of medium or higher on `main` at the release commit.

## 5. Documentation

- [x] Support, versioning and deprecation policy and the upgrade guide ([versioning.md](../guide/versioning.md),
      [upgrading.md](../guide/upgrading.md), P9-05), linked from SECURITY.md and the README.
- [x] Every internal link and anchor in `docs/` checked by `pnpm lint`; the site build checks them again (P9-04).
- [ ] *owner:* GitHub Pages enabled, the site live at <https://mhidalgo-lab.github.io/agility-bridge/>
      ([P9-04](../tasks/phase-9-hardening-launch/P9-04-docs-site.md)).
- [ ] README status block rewritten for 1.0 (no "pre-1.0"), with the version and what is still unverified.
- [ ] The documented commands of the quickstarts run on the release candidate (L-133).

## 6. Provenance

- [x] Verification guide executed by the author against 0.8.0: checksums, npm provenance and signatures, SBOM, GHCR
      attestations ([verify-release.md](../guide/verify-release.md), P9-07).
- [ ] *owner:* the guide executed by someone other than the author (P9-07; threat evidence L-5).
- [ ] *owner:* the `v*` tag ruleset created and `release/*` creation restricted (D-368;
      [repo settings](../security/repo-settings.md)).
- [ ] *owner:* after 1.0.0 is live, the guide re-run against 1.0.0 (tarball, image by digest, Sigstore bundle).

## 7. Rollback

What a bad 1.0.0 means and how each channel goes back (see also [Upgrading → Rolling back](../guide/upgrading.md#rolling-back)):

| Channel | Rollback | Notes |
|---|---|---|
| npm | `npm dist-tag add agility-bridge@<last good> latest`, then `npm deprecate agility-bridge@1.0.0 "<reason>"` | A published version cannot be replaced; fix forward with 1.0.1. Never unpublish. |
| GHCR | Users pin the previous `X.Y.Z` tag or digest; the next release moves `latest` and `1.0` forward | Tags never move backwards (L-128); do not re-push an older image as `latest`. |
| Cloudflare Worker | `wrangler rollback` to the previous deployment, or redeploy the previous version | A D1 database already migrated by 1.0 may be refused by an older build: restore the backup taken before the upgrade. |
| Self-hosted (Node, Docker) | Redeploy the previous version and restore the database backup if 1.0 migrated it | Same refusal rule (`MigrationError`). |

- [ ] *owner:* decide the rollback triggers before release (for example a data-exposure bug, a write applied to the wrong
      item, an authorization bypass: deprecate at once and announce in the security advisory).

## 8. Release notes and announcement

- [ ] The 1.0.0 release notes: the changesets of the release plus a short summary at the top (what 1.0 promises under
      the [versioning policy](../guide/versioning.md), what is still unverified, upgrade notes from 0.x). A draft summary
      is below.
- [ ] *owner:* the announcement (where: README, GitHub Release, MCP Registry listing, plugin marketplace; see
      [registry-listing.md](../guide/registry-listing.md)).

Draft summary for the top of the 1.0.0 notes:

> agility-bridge 1.0.0 is the first stable release. From here on the tool names and schemas, configuration, CLI
> flags, HTTP routes and storage follow the [versioning policy](../guide/versioning.md): breaking changes only in a major
> release, deprecations announced at least one minor release and six months ahead. Upgrading from 0.x: back up the
> database, upgrade, reconnect every MCP client so it reloads the tool list ([upgrading](../guide/upgrading.md)). Still
> unverified at release: the items marked *live* in the [launch checklist](launch-checklist.md).

## Cutting 1.0.0

1. Every item above is ticked or moved out of 1.0 by a recorded decision; the owner signs off below.
2. A pull request adds a **major** changeset for `agility-bridge` (`pnpm changeset`, bump `major`) with the summary above,
   updates the README status block and ticks §5. Merging it makes the Version Packages PR propose 1.0.0.
3. Run the LLM tool evaluation if `tools/list` changed since the last report ([releasing.md](releasing.md#before-a-release-that-changes-tools-owner)).
4. Release with the normal flow ([releasing.md](releasing.md#flow)): Version Packages PR, `release` approval, npm 2FA
   approval, the second *Release* run for the GitHub Release and the image.
5. Verify 1.0.0 with the [verification guide](../guide/verify-release.md) and tick §6.
6. Set P9-08 to `review` and mark Phase 9 done in the [roadmap](../ROADMAP.md).

## Sign-off

- [ ] *owner:* checklist reviewed and 1.0.0 approved for release (name, date).
