# OpenSSF Scorecard triage

> P9-06, 2026-11-03. Source: the public result for this repository,
> <https://api.scorecard.dev/projects/github.com/mhidalgo-lab/agility-bridge> (Scorecard v5.6.0, run 2026-11-03,
> overall **7.7 / 10**), and the open code-scanning alerts (`gh api repos/mhidalgo-lab/agility-bridge/code-scanning/alerts`).
> The workflow that produces it is [`scorecard.yml`](../../.github/workflows/scorecard.yml) (weekly, on push to `main`).

## Checks at 10

Security-Policy, Dangerous-Workflow, Dependency-Update-Tool, Token-Permissions, Binary-Artifacts, Pinned-Dependencies,
License, Signed-Releases, Vulnerabilities, Packaging, SAST, Fuzzing, CI-Tests. Nothing to do. (Token-Permissions lists
`contents: write` on two release jobs as a warning and still scores 10: they create the tag and the release and nothing else.)

## Checks below 10

| Check | Score | Cause | Fix or decision | Who |
|---|---|---|---|---|
| Code-Review | 0 | 0 of 29 merged changesets had an approving review: a single maintainer merges his own pull requests after CI. | Not a quick win. A required approval needs a second person who can approve; with one maintainer it would block every merge. Decision D-348. | owner |
| Branch-Protection | 4 | `main` forbids deletion and force pushes, applies to administrators, requires up-to-date branches and dismisses stale reviews, but does not require approvers, code-owner review or last-push approval. | Same cause as Code-Review: the three missing items need a second reviewer. Rulesets are the owner's to change ([repo settings](repo-settings.md)); D-348. | owner |
| Maintained | 0 | The repository was created on 2026-10-16: Scorecard gives 0 to any project younger than 90 days. | Time only. It rises from 2027-01-14 as activity continues (hundreds of commits so far). | none |
| CII-Best-Practices | 0 at triage | No OpenSSF Best Practices badge at triage time. | Passing badge earned 2026-11-03 (project 16294, [best-practices-answers.md](best-practices-answers.md)); the next Scorecard run picks it up. | done |
| Contributors | 3 | Contributions come from one organisation. | Cannot be fixed by code; it moves as outside contributors arrive. Accepted. | none |

## Open code-scanning alerts

The four open alerts are these same Scorecard checks (CIIBestPracticesID, CodeReviewID, MaintainedID, BranchProtectionID),
not findings in code. There are no open CodeQL alerts. They close by themselves when the check passes; dismissing them with
"won't fix" is possible in the GitHub UI but hides a real gap, so this page is the record instead.

## Quick wins

None were left on the table by the scan: every check that can be satisfied by a file or a workflow already scores 10. The
one change made for this task found while mapping ASVS V13.4 is a test that probes for exposed source-control, environment,
debug and documentation paths (`packages/http-app/test/exposure.test.ts`).
