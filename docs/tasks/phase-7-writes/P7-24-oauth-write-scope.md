---
id: P7-24
title: "OAuth `mcp:write` scope and non-remembered write consent"
phase: 7
status: review
priority: medium
depends_on: [P7-02, P7-07]
adr: ["0013"]
lessons: [L-010, L-133]
owner: ""
---

# P7-24 — OAuth `mcp:write` scope and non-remembered write consent

> Filed by [P7-08](P7-08-write-docs-threat-model.md) (D-189). Built on fakes; the real-client run is the owner step below. Decisions D-201 to D-203.

## Goal
A person who connects through OAuth (claude.ai, mobile, connectors, any client that signs in) can use write tools, with a separate consent that is never remembered. Today the OAuth server issues only `mcp:read` and passes `writeScope: false` to the access resolver (`packages/http-app/src/oauth/server.ts`), so an OAuth connection never offers a write tool although ADR-0013 and the guide describe the scope.

## Scope
- Advertise `mcp:write` (metadata, `scopes_supported`), accept it in the authorization request, show a distinct write consent on the consent screen that is never remembered (P5-13 remembered consent must not cover it), carry it on the token and pass `writeScope` to `resolveAccess` only for a token that holds it.
- The access layer already honours the scope (`packages/auth/test/resolve.test.ts`); the work is the OAuth server, the consent page and refresh (a refresh must not widen a token to write).
- Docs: replace the "OAuth connections do not offer write tools yet" notes in the write guide and the client approval table.

## Acceptance criteria
- [x] A token without `mcp:write` never offers a write tool, with and without a workspace that allows writes (negative test, no upstream call): `defineOAuthWriteScopeSuite` on memory, SQLite and workerd/D1.
- [x] A token with it offers the tools its grant names, and only after a consent that was not remembered from an earlier read-only consent (the box is never ticked on load or on a second render: `consent.test.ts`).
- [x] The scope is requested with `mcp:read`, granted only when the server switch, workspace, grant and a personal credential allow writes (`write_unavailable` otherwise: not enabled, shared credential, switch off, app did not ask); advertised only with the switch on (D-201).
- [x] Refresh keeps the scope the token had and cannot add `mcp:write` (refused before the token is spent).
- [x] Revoking the consent or disconnecting removes write at once; the consent (granted scope) and the revocation are audited. Recoverable-refusal rules (P5-21) are untouched (the decision at a refresh passes the carried scope).
- [x] THREAT_MODEL T31 residual about OAuth is closed or restated.
- [ ] A real client run (claude.ai or Claude Code) shows the write consent and one approved write on staging (owner step, P7-10).

## Security notes
Writes over OAuth widen what a stolen OAuth token can do; the scope must be explicit, short-lived with the token, and covered by the write limiter and approval like every other write (THREAT_MODEL T31, T9).

## Follow-ups
- [P7-32](P7-32-oauth-write-scope-on-my-access.md) shows the scope on *My access*; [P7-33](P7-33-oauth-write-step-up.md) step-up instead of reconnecting.

## Lessons applied
- L-010 — Every security claim needs evidence.
- L-133 — Execute the documentation.

## Docs to update
- docs/guide/write-tools.md
- docs/reference/client-compatibility.md
- docs/guide/oauth-how-it-works.md
- docs/THREAT_MODEL.md

## Out of scope
- Anything not listed under Scope.
