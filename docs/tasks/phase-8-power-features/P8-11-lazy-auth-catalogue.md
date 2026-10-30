---
id: P8-11
title: Lazy auth and public tool catalogue
phase: 8
status: done
priority: low
depends_on: [P6-13]
adr: ["0009"]
lessons: [L-016]
owner: ""
---

# P8-11 — Lazy auth and public tool catalogue

## Goal
Registries and clients can discover the read-only catalogue without credentials, when the operator wants it, without
learning anything about any workspace, tenant or write capability.

## Scope
- `AB_PUBLIC_TOOL_CATALOG=on` (off by default; a shared server setting, so Node and Workers read it the same way).
- On `POST /w/{slug}/mcp`, when **no credential header at all** is presented (no `Authorization`, no `X-Agility-Token`),
  these methods are answered from a static catalogue: `initialize`, `server/discover`, `ping`, `tools/list`, and the
  `notifications/initialized` notification (it has no effect; without it a client's handshake would end in a `401`
  that sends it to authentication too early). Every other method, and every request that presents a credential
  (valid or not), goes through the normal path and answers as before (`401` for the missing credential).
- The catalogue is the read-only tools of the default groups (the same set an unconfigured stdio server lists:
  no `attachments`, `reports` or `writes` group), taken from the tool registry; the handlers are replaced by ones that
  refuse, and `tools/call` is never forwarded.
- The answer does not depend on the slug: no storage read, no workspace lookup, no per-workspace limits, groups,
  names, instructions or tool counts. The same bytes (apart from the JSON-RPC id and the protocol era) for a real, an
  unknown, a disabled and a malformed slug.
- The per-IP limit applies as for any MCP request; the answers are not audited as refusals (they are not refusals), and
  nothing is charged to the authentication-failure budget.
- stdio already lists the same tools without configuration (setup mode); this task pins that with a test and shares
  one group list between the two.
- Docs: configuration guide; self-hosting note that clients then see the catalogue before signing in.

## Acceptance criteria
- [x] Off by default: without the setting, an unauthenticated `initialize` and `tools/list` answer `401` as before.
- [x] On: the five allowed messages are answered for a request without a credential, on both protocol eras
      (`initialize` and `tools/list` on the 2025-era stateless path, `server/discover` and `tools/list` on 2026-07-28).
- [x] The response is identical for a real, an unknown, a disabled and a malformed slug, and no storage method is
      called (a storage double that fails on any call).
- [x] No write or destructive tool, no tool of an opt-in group and no workspace-specific text ever appears in the answer.
- [x] `tools/call`, `prompts/*`, `resources/*`, `completion/*`, `tasks/*` and any unknown method without a credential
      still answer `401`; a request with a bad credential gets `401` even for `tools/list`; a non-`POST` gets `401`.
- [x] stdio without configuration lists exactly the public catalogue.
- [x] The setting is validated (`on`/`off`), warned at start, documented and known to both hosts.

## Security notes
THREAT_MODEL T33.

## Lessons applied
- L-016 — Advertise only what works on that transport.

## Docs to update
- docs/guide/configuration.md

## Out of scope
- Anything not listed under Scope.
