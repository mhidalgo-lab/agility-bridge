---
id: P4-10
title: Admin documentation
phase: 4
status: done
priority: medium
depends_on: [P4-04]
adr: []
lessons: [L-133, L-232]
owner: "claude-agent"
---

# P4-10 — Admin documentation

## Goal
An operator goes from nothing to a signed-in owner and a connected MCP client by following one page, and then finds
everything about running the admin side (who can do what, re-authentication, sessions, unbind, member self-service,
audit and usage, the panel's security properties, troubleshooting) from one hub, with no stale statement left over from
before the panel existed.

## Refinement (2026-10-23)

Phase 4 is built (P4-01 to P4-08, P4-12 to P4-15); this task writes the pages that tie it together. Ported and adapted
from relic-bridge's `admin-guide.md` (same owner, Apache-2.0). The existing guides already describe each screen and flow
(P4-01 to P4-07 each documented their part), so this task adds what they lack: the end-to-end path, the hub, the role matrix
and the troubleshooting. Differences that matter: there are no screenshots (the browser run of P4-08 does not produce them),
the device-token flow and connect page are agility-bridge's own, and two hosts are walked through (Node `serve` behind
HTTPS and the Cloudflare Worker).

## Scope
- `docs/guide/quickstart-remote.md` (new, deferred here by P4-07): nothing to a signed-in owner and a connected client, for
  `serve` behind HTTPS and for Cloudflare (`pnpm cf:setup --sign-in`): the setup link, an identity provider, an instance, a
  credential, a workspace, a grant, a device token, the connect page.
- `docs/guide/admin-guide.md` (new): the hub. Who can do what (a role matrix that a test checks against the guards),
  letting people in, the first owner, a team setup with personal tokens, everyday tasks, re-authentication, sessions,
  unbind, member self-service, audit and usage, the panel's security properties, and troubleshooting (sign-in failures,
  `403 reauth_required`, `Clear-Site-Data`, cookies on http and https, the `form-action` note of D-35).
- A test (`scripts/test/role-matrix.test.ts`) that parses the matrix and runs every row against the real guards.
- Cross-links and a doc index: README, `admin-panel.md`, `admin-access.md`, `identity-providers.md`, `access-model.md`,
  `cli.md`, `cloudflare-deploy.md`, `self-hosting.md`, `troubleshooting.md`.
- `docs/guide/cloudflare-limits.md`: the panel rows become the CI figures of 2026-10-23 (relative to the calibration), not
  the local estimates measured on a busy machine.
- Remove stale statements ("a browser run is P4-08", "the connect page comes next", "does not exist yet", and the like).
- Set P4-14 and P4-15 (merged, reviewed) to `done`.

## Acceptance criteria
- [x] `quickstart-remote.md` covers both hosts with real commands; its runnable snippets are marked for the doc tests.
- [x] `admin-guide.md` exists and links every admin guide; each topic in Scope is reachable from it.
- [x] The role matrix is tested against the guards (`scripts/test/role-matrix.test.ts`): a changed guard or a changed row fails.
- [x] Troubleshooting covers sign-in failures, `403 reauth_required`, `Clear-Site-Data`, cookies on http and https, and the
  `form-action` note.
- [x] The panel rows of `cloudflare-limits.md` carry the CI figures with the date and keep the D-27 note.
- [x] README and the guides link the new pages; a grep for stale statements finds none.
- [x] Documented commands still run (L-133): `scripts/test/docs.test.ts` passes (the `npx` blocks need the registry offline: they
  time out locally without network and pass on CI).
- [x] Lint, typecheck and tests green; task set to `review`.

## Security notes
Documentation only. Example tokens are obviously fake and shaped so secret scanners do not flag them. The guide states what
the panel protects and what it does not (never a secret in a page, the setup link in a fragment, the takeover window after an
unbind).

## Lessons applied
- L-133 — Execute the documentation.

## Docs to update
- docs/guide/quickstart-remote.md (new), docs/guide/admin-guide.md (new), docs/guide/admin-panel.md,
  docs/guide/admin-access.md, docs/guide/access-model.md, docs/guide/identity-providers.md,
  docs/guide/cloudflare-limits.md, docs/guide/troubleshooting.md, README.md

## Out of scope
- Screenshots (a follow-up once the E2E run can produce them).
- Anything not listed under Scope.

## Outcome

- **Built**: `docs/guide/quickstart-remote.md` (Node behind HTTPS and Cloudflare with `cf:setup --sign-in`, the setup link, the
  panel steps, the connect page, a check with `curl`), `docs/guide/admin-guide.md` (the hub, the tested role matrix, team setup
  with personal tokens, everyday tasks, re-authentication, sessions, unbind, member self-service, audit and usage, the panel's
  security properties, troubleshooting), `scripts/test/role-matrix.test.ts`, links from the README and every related guide,
  lesson L-232.
- **Stale statements fixed**: the headers of `admin-panel.md`, `admin-access.md` ("still to come", "no real browser has driven
  it") and `identity-providers.md` ("screens follow in P4-04"), the README's Phase 1 banner, `cli.md` ("the admin panel, Phase 4"),
  `docs/dev/admin-ui.md` ("Not in the panel (yet)", "P4-03 ships the frame and two small pages"), and RESEARCH §9 (the
  `form-action` behaviour is now confirmed in Chromium; Firefox and WebKit stay unverified).
- **cloudflare-limits**: panel rows are the CI figures of 2026-10-23 (first `/admin` 6.5x the calibration, about 17 ms; warm pages
  about 1 to 4 ms); the D-27 note for the first request stays.
- **Doc tests**: the role matrix runs all 21 rows against the guards; two `npx -y agility-bridge ... --help` blocks (offline
  they time out locally on the 5 s limit, they pass on CI).
- **Not done**: the guides were not walked through on a fresh real deployment (needs a real provider application and a
  Cloudflare account: an owner step, [pending decisions](../../pending-decisions/phase-4.md)); no screenshots. The commands
  were checked individually against the CLI and the existing walkthroughs.
