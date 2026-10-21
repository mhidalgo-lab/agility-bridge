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
  drift** (every product attribute the tools rely on, listed in `live/expected-metadata.ts`, exists; a failure names
  only product attributes), paging by `ID` with `limit + 1`, and the output shaper on real rows (envelope present,
  `structuredContent` rows equal to the rows shown, no `null`). Assertions are on counts and shapes only.

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

Custom attributes exist on backlog items, defects and epics (none on tasks and tests); their names are not recorded.

**Gaps for the writable sandbox:** requests, regression tests, plans and suites, and test sets (no live data here), plus
every write path and a second member for reader/writer permission differences.

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
