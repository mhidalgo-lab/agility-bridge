---
id: P2-19
title: Instance URL policy for servers (no plain HTTP, optional private-address refusal)
phase: 2
status: done
priority: medium
depends_on: [P2-13]
adr: ["0014"]
lessons: [L-065]
owner: ""
---

# P2-19 — Instance URL policy for servers

## Goal
Close the gap found in the Phase 2 review: `canonicalInstanceUrl` accepts `http://localhost` and `http://127.0.0.1`
in every mode (meant for tests), and any `https://` host, private and link-local ranges included. An administrator of
`agility-bridge serve` can therefore point an instance at a loopback service in clear text, and the unauthenticated
origin probe answers whether something listens there (a blind probe oracle). THREAT_MODEL A9 and ADR-0014 say "HTTPS
only (loopback for tests)".

## Scope
- `serve` and the management commands refuse `http://` instance URLs unless `AB_ALLOW_HTTP_INSTANCES=on` (documented
  as for tests and local fixtures only, logged as a warning at start); the stdio mode keeps today's behaviour for
  local development. The test suites, `scripts/walkthrough.ts`, `scripts/docker-smoke.ts` and the fixture-based docs
  set the switch explicitly.
- An optional `AB_INSTANCE_PRIVATE_ADDRESSES=refuse` resolves the instance host and refuses loopback, private,
  link-local and metadata addresses at create time and at connect time (DNS rebinding); default `allow`, because
  on-premises instances live on private networks.
- The origin probe's errors stay uniform for "nothing listens" and "not an Agility instance" when the switch refuses.

## Acceptance criteria
- [x] Tests: `http://127.0.0.1` refused by `serve` without the switch, accepted with it; a private address refused
      with `refuse`, at create and at connect; the stdio mode unchanged.
- [x] THREAT_MODEL A9 and the configuration guide describe both settings; the walkthrough still passes.

## Security notes
Private addresses are an accepted residual risk by default (on-premises instances need them); only owners and admins
define instances, and every change is audited.

## Lessons applied
- L-065 — Every alternate writer is an authorization boundary (CLI, admin API and storage apply the same policy).

## Docs to update
- docs/guide/configuration.md, docs/guide/self-hosting.md, docs/THREAT_MODEL.md (A9)

## Out of scope
- The Cloudflare Worker deployment (Phase 3 applies its own egress rules).
