---
id: P4-10
title: Admin documentation
phase: 4
status: in-progress
priority: medium
depends_on: [P4-04]
adr: []
lessons: [L-133]
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
- [ ] `quickstart-remote.md` covers both hosts with real commands; its runnable snippets are marked for the doc tests.
- [ ] `admin-guide.md` exists and links every admin guide; each topic in Scope is reachable from it.
- [ ] The role matrix is tested against the guards (`scripts/test/role-matrix.test.ts`): a changed guard or a changed row fails.
- [ ] Troubleshooting covers sign-in failures, `403 reauth_required`, `Clear-Site-Data`, cookies on http and https, and the
  `form-action` note.
- [ ] The panel rows of `cloudflare-limits.md` carry the CI figures with the date and keep the D-27 note.
- [ ] README and the guides link the new pages; a grep for stale statements finds none.
- [ ] Documented commands still run (L-133): `scripts/test/docs.test.ts` passes (the `npx` blocks need the registry offline: they
  time out locally without network and pass on CI).
- [ ] Lint, typecheck and tests green; task set to `review`.

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
