---
id: P3-13
title: Master-key status and retirement through the admin API; init --version
phase: 3
status: done
priority: medium
depends_on: [P3-08]
adr: ["0007"]
lessons: [L-075]
owner: ""
---

# P3-13 — Master-key status and retirement through the admin API; `init --version`

## Goal
Finish a master-key rotation on a deployment whose database the operator cannot open locally (the Worker on D1).

## Scope
- Admin API (owner, recent sign-in where sessions exist): `GET /keys` (credentials per key version, loaded, current,
  retired) and `POST /keys/{version}/retire` (refused while a credential uses it), audited like the CLI's
  `keys status` / `keys retire`; the management commands use them in remote mode.
- `agility-bridge init --key-file <new file> --version <N>` writes a key for version N (a rotation needs a higher
  version than the current one); `--version` defaults to 1.
- The secrets and deploy guides use them.

## Acceptance criteria
- [x] Negative authorization tests for both routes (member, admin where owner-only); remote `keys status` and
      `keys retire` give the same output as local.
- [x] A rotation on workerd driven end to end: new key, cron runs until nothing remains, retire through the API.

## Security notes
THREAT_MODEL T7, T14.

## Lessons applied
- L-075 — Envelope encryption done properly.

## Docs to update
- docs/guide/secrets.md, docs/guide/cloudflare-deploy.md, docs/reference/admin-api.md

## Out of scope
- Rotating the admin token (a separate secret).
