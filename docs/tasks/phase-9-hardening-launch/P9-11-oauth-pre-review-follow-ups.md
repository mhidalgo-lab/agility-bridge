---
id: P9-11
title: OAuth pre-review follow-ups (code burn, refresh claim, revoke tombstone)
phase: 9
status: todo
priority: low
depends_on: [P9-02]
adr: []
lessons: [L-086, L-121]
owner: ""
---

# P9-11 — OAuth pre-review follow-ups

## Goal
Remove three low-severity races and denial-of-service edges the internal pre-review (P9-02) found in the OAuth token endpoint.
None is a token theft (PKCE holds); each needs care around the provider's internals, so none was changed in the review PR.

## Scope
- **Code burn.** `server.ts` takes the authorization code marker (`kv.take(codeMarker)`) before the provider checks `client_id`,
  `redirect_uri` or `code_verifier`, so someone holding a code can spend it with a wrong verifier, and the replay path
  (`revokeReplayed`) then revokes the device. Check the client id and the verifier against the stored grant before taking the
  marker, or restore the marker on `invalid_grant` and `client_mismatch`; revoke on replay only after the client matched.
  `suite.ts` pins the current behaviour as intended (RFC 6749 asks for revocation on code reuse): decide whether a refused
  attempt counts as a reuse.
- **Refresh claim.** The claim lives 15 seconds without renewal and its `finally` deletes the row even when it belongs to
  another request, so a slow provider call can let two refreshes succeed with no reuse detection. Delete only a claim with this
  request's nonce and check the elapsed time before writing the success marker.
- **Revoke tombstone.** RFC 7009 `revoke` goes straight to the provider's `revokeGrant`, not through `revokeFamily`, so a refresh
  in flight can write the grant back. Set the tombstone before delegating for a provider-shaped token.

## Acceptance criteria
- [ ] A wrong verifier or client id does not spend the code or revoke the device; a correct exchange afterwards succeeds
      (test that fails without the fix); replay of a spent code still revokes.
- [ ] Two concurrent refreshes with a slow provider and a clock moved past the claim lifetime give one success and one
      replay answer; the claim of another request is never deleted.
- [ ] A refresh in flight cannot resurrect a revoked grant (test).
- [ ] Threat model T9, T15 updated.

## Security notes
T9, T15, T20.

## Lessons applied
- L-086 — OAuth state in shared storage, never isolate memory.
- L-121 — Negative tests that fail when the fix is reverted.

## Docs to update
- docs/THREAT_MODEL.md, docs/dev/oauth.md

## Out of scope
- Changes to the provider library itself.
