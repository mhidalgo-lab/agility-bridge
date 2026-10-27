# Live verification

How agility-bridge is checked against a real Agility instance (P0-12, L-003, L-125). Until a writable sandbox exists
(owner checklist, before Phase 7) the only instance is the owner's account in a **third-party company's tenant**, usable
strictly read-only (D-01, THREAT_MODEL A15). That company is aware of the read-only API testing (confirmed 2026-10-21).

## Rules for the read-only tenant

- Every request goes through `live/readonly-fetch.ts`: `GET` on `meta.v1` and `rest-1.v1` `Data`/`Hist`, `POST` on
  `query.v1`. Any other endpoint, method, host, `op=` operation or redirect is refused before it is sent (tested in
  `scripts/test/live-guard.test.ts`).
- Nothing from the tenant is committed or printed: no content, names, ids, custom attribute names or the instance URL.
  Probes print shapes only (`live/shape.ts`); counts are recorded as coarse levels. Raw results go to the git-ignored
  `live/results/`.
- No rate-limit, quota or error-count probing; one request at a time.
- Fixtures are synthetic and written by hand (checklist below), never derived from tenant responses.

## Running the live suite

- **Locally:** put `AB_LIVE_AGILITY_URL` and `AB_LIVE_AGILITY_TOKEN` in `~/.config/agility-bridge/live.env`
  (`chmod 600`, outside the repository; refused if group- or world-readable), or export them, then `pnpm test:live`.
  Without them the suite skips.
- **CI:** Actions → **Live** → *Run workflow* on `main`, then approve the `live` environment. The workflow is manual only,
  never runs on pull requests or forks, and its logs are public, so the suite prints nothing from the tenant.

What it checks (about 40 read requests, one at a time):

- `live/inventory.live.test.ts`: the token works; the tenant inventory as size buckets (git-ignored `live/results/`).
- `live/client.live.test.ts` (P1-12): the **production client** from `packages/core` sends every request through
  `live/guarded-fetch.ts`, which applies the same read-only guard to each `Request` (writes are refused before they are
  sent, tested in `scripts/test/live-guard.test.ts`). It checks authentication and budget accounting, **metadata
  drift** (the committed synthetic `meta.v1` snapshot against the tenant on product attributes: names, types, multi-value,
  relation targets and bases; a failure names only product attributes), paging by `ID` with `limit + 1`, and the output shaper on real rows (envelope present,
  `structuredContent` rows equal to the rows shown, no `null`). Assertions are on counts and shapes only.

- `live/collaboration.live.test.ts` (P6-04): `get_conversations` and `list_attachments` on real assets (counts and shapes
  only), the product attributes they read, and `get_attachment` up to its metadata checks (scope, ID and parent match,
  every content type refused, so no content request is made). **Gap:** the guard allows no `attachments.img` request, so
  the download itself is verified on fixtures only (tracked in P6-19).

- `live/sprint.live.test.ts` (P6-02): `get_sprint` on a recently used past and current sprint (picked by one read of the newest
  items, addressed by OID): the categories add up to the items counted, history is at most 15 ordered points never after now,
  the last point equals the totals' remaining estimate, no `null`, the envelope is present. Records coarse levels to the
  ignored `live/results/sprint.json`. Findings: sprint dates have no zone (L-276), sprints hold hundreds of items (L-279).

- `live/portfolio.live.test.ts` (P6-01): the portfolio tools through the production client and guard. Passed 2026-10-27
  (Agility 26.0.3.2, third-party tenant, read-only): `list_portfolio_items` returned live epics with identity, a category
  (a value of `Epic.Category`) and the aggregated child count (`Subs` with the dead-asset bracket filter), a category filter
  and a disjoint second page; `get_portfolio_tree` returned a two-level tree with consistent roll-ups (done and open-defect
  counts never above the item count, percentages within 0 to 100, parents never below their children) and no `null`; a
  story given as the asset was refused. Both tools stayed within their declared costs on a cold cache (also checked for
  every catalogue tool in `client.live.test.ts`). Assertions are booleans with our own labels (L-274); coarse levels only
  (epics: 100+, tree: 2 levels, items counted: fewer than 100).

## Tenant inventory (2026-10-21, Agility 26.0.3.2, hosted)

Recorded by `live/inventory.live.test.ts` as size buckets and published here at a coarser level (the repository is
public): **absent**, **present** (fewer than 100) or **100+** (enough to test paging).

| Asset type | Level | | Asset type | Level |
|---|---|---|---|---|
| Agility projects (`Scope`) | present | | Issues | 100+ |
| …with a parent project | present | | Requests | **absent** |
| Teams | 100+ | | Regression tests | **absent** |
| Sprints (`Timebox`) | 100+ | | Regression plans | **absent** |
| Members | 100+ | | Regression suites | **absent** |
| Backlog items (`Story`) | 100+ | | Test sets | **absent** |
| Defects | 100+ | | Conversations (`Expression`) | 100+ |
| Tasks | 100+ | | Attachments | 100+ |
| Tests | 100+ | | Links | 100+ |
| Epics | 100+ | | Epic categories | present |

P6-06 (`live/other-assets.live.test.ts`, 2026-10-27) added the planning types through `query_assets` and `get_assets`
with default tiers: goals, themes, retrospectives and issues are **present**; requests are **absent** (the type answers with
an empty page), so the request recipe is verified on fixtures only (tracked in P6-27).

Custom attributes exist on backlog items, defects and epics (none on tasks and tests); their names are not recorded.

**Gaps for the writable sandbox:** requests, regression tests, plans and suites, and test sets (no live data here), plus
every write path and a second member for reader/writer permission differences.

**Gaps for the writable sandbox (history, P6-05):** "history matches known edits" cannot be checked on this tenant (no
edits of ours to compare against). `live/history.live.test.ts` checks consistency instead: recently changed assets come back
inside their window, and the newest history value of `Name`, `Status.Name` and `Estimate` equals the current value.
Recorded as [P6-21](../tasks/phase-6-tool-breadth/P6-21-history-sandbox-verification.md).

**API observations** (recorded in RESEARCH §1): `query.v1` ignores `needTotal` and `rest-1.v1` reports only
`pageSize`/`pageStart` on this version, so the tenant offers no total count; `rest-1.v1` answers JSON with
`Accept: application/json`.

## Evidence template

Copy into the PR or the task's results file for every live check:

```text
Date (UTC):
Instance: read-only third-party tenant | writable sandbox | other (version: …)
Workspace / grant: … (agility-bridge side)
What was checked:
Asset numbers: (writable sandbox only; never for the third-party tenant)
Expected:
Actual: (shapes, counts or levels for the third-party tenant)
Redactions: what was removed and why
Command or recipe to reproduce:
```

## Synthetic-fixture checklist

Sign this in the PR for every new or changed fixture:

- [ ] Written by hand, or generated from a seed; not copied from, or derived from, a tenant response.
- [ ] Names, numbers, OIDs, emails and URLs are obviously fake (`example.com`, `Synthetic …`, `B-0xxxx`).
- [ ] No real access token, `ab_` token, master key or cookie; secret-shaped values only under
      `scripts/test/fixtures/secrets/`.
- [ ] Hostile cases included where the fixture feeds tool output: quotes, HTML, prompt-injection text, very long strings,
      Unicode (L-122).
- [ ] `gitleaks` passes locally or in CI.

## Self-hosting walkthrough (P2-16)

The setup the guides describe is executed, not just read (L-133): `scripts/walkthrough.ts` runs every shell block
marked `<!-- walkthrough: N -->` in `docs/guide/self-hosting.md` and `docs/guide/cli.md`, in order and verbatim, in a
fresh `node:24-bookworm` container (digest-pinned) that installs the package packed from the checkout. It substitutes
only the npm name (→ the tarball), the example instance and public URLs (→ the synthetic Agility and the local server)
and the `<…-id>` placeholders (→ the ids printed by the previous commands), prints each substitution, and redacts device
tokens from its output. The CI Docker job runs it on every change; the image itself is covered by
`scripts/docker-smoke.ts` in the same job.

| Date | Where | Package | Result |
|---|---|---|---|
| 2026-10-21 | Fresh container (`node:24-bookworm@sha256:7b559cf7…`), Docker 29.9.1 on WSL2 | `agility-bridge-0.1.0.tgz` packed from the P2-16 branch | Passed: install, `init`, `admin-token`, instance (origin probe), credential (validated: member and projects), user, workspace, grant, device token, `serve`, `/health`, `tools/list` with the device token listing exactly the granted tools |

A container is not a full virtual machine (no init system, no reverse proxy, no TLS); the systemd unit, the proxy
configurations and the Compose file are validated separately (`docker compose config`, `caddy validate`) and by the
image smoke test.

## Cloudflare deployment (P3-05, P3-07)

Executed against the owner's Cloudflare account (Free plan) on the owner-approved name `agility-bridge-staging`
(`workers.dev`), following [the deploy guide](../guide/cloudflare-deploy.md). No Agility tenant is reached from the
Worker (D-01): instances are a synthetic one at an unreachable address and Digital.ai's public example instance
(unauthenticated `meta.v1` only).

| Date | Step | Result |
|---|---|---|
| 2026-10-22 | `pnpm cf:setup --name agility-bridge-staging --secrets-file …` (first run) | D1 created, local config written, deployed, both secrets set through stdin into a `0600` file; first `/health` got `403` without `AB_PUBLIC_URL` (L-180), fixed in the script |
| 2026-10-22 | `pnpm cf:setup --name agility-bridge-staging` (again) | Only a redeploy; nothing created |
| 2026-10-22 | Smoke | `/health` 200 with HSTS; admin API 401 without and 200 with the break-glass token; MCP 401 without a token |
| 2026-10-22 | `pnpm cf:migrate --name agility-bridge-staging --from <synthetic backup>` | First refused as "not empty" (two refusal audit rows, L-181), then imported with counts verified; the migrated device token listed 13 tools |
| 2026-10-22 | `AB_ADMIN_URL=… agility-bridge instance add "Example (public)" https://www14.v1host.com/v1sdktesting` | Created through the Worker's admin API; the Worker probed the origin from Cloudflare (metadata fingerprint recorded) |
| 2026-10-22 | `wrangler tail` CPU | Warm `tools/list` 4–10 ms; a new isolate's first request 38–80 ms (P3-14) |

Not executed (owner resources): a custom domain on a zone with the WAF exception, and an Agility credential on the
Worker ([pending decisions](../pending-decisions/phase-3.md)).

