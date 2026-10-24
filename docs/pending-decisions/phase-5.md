# Pending decisions — Phase 5

> Open questions and owner steps from Phase 5. Answer inline (`**Owner:** …` with a date).

## Open decisions

### D-60 — `AB_OAUTH=on` is refused until the consent screen exists *(P5-01)*
- **Context:** P5-01 builds the authorization server, but the step where a person signs in and approves a client is P5-04.
  With the server on and no way to approve, `/oauth/register` would store clients nobody can use.
- **Options:** (a) parse and validate the settings now, refuse `AB_OAUTH=on` at start with a message naming P5-04, and let
  P5-04 lift the refusal; (b) allow `on` with an authorize endpoint that always answers "not available".
- **Recommendation:** (a): a boot error is clearer than a half-working feature, and nothing is exposed before it is usable.
- **Owner:** _pending_ (implemented as (a)).

### D-61 — `resource` is required at authorization, optional at the token endpoint *(P5-01)*
- **Context:** the workspace is the RFC 8707 resource, so an authorization request without one cannot name a workspace.
  At the token endpoint, if `resource` is sent it must be ours and the grant's own; if it is left out the grant's applies.
- **Options:** (a) as described (lenient at the token endpoint, so clients that leave it out on refresh keep working);
  (b) require it on every request like relic-bridge, which fails clients that do not repeat it.
- **Recommendation:** (a): the grant already fixes the workspace, so requiring it again adds no safety and costs
  compatibility (L-094). Clients that send no `resource` at authorization need P5-02 (metadata) to learn it.
- **Owner:** _pending_ (implemented as (a)).

### D-62 — Grant properties are encrypted by the provider, not by a keyring purpose *(P5-01)*
- **Context:** ADR-0009 promises envelope-encrypted grant properties. The provider encrypts them with a key wrapped under
  each token, so a database copy, even with the master key, cannot open them; a keyring purpose would be weaker.
- **Options:** (a) rely on the provider's scheme (no new `KeyPurpose`); (b) add a keyring purpose and encrypt again.
- **Recommendation:** (a). Props hold only ids (workspace, access grant, user, client). P5-05's refresh-reuse successor,
  which must be recoverable, gets its own derived key.
- **Owner:** _pending_ (implemented as (a)).

### D-63 — Until P5-05, a rotated refresh token works once more *(P5-01)*
- **Context:** the provider keeps the previous refresh token valid until the new one is first used, so a lost response
  cannot strand a client. A stolen, already-rotated token therefore refreshes once more.
- **Options:** (a) accept until P5-05 adds reuse detection and the 30-second window; (b) block now with a marker per
  refresh token (relic-bridge's P5-05 design, pulled forward).
- **Recommendation:** (a): P5-05 is next, `AB_OAUTH` cannot be on before P5-04, and the window it builds replaces this rule.
- **Owner:** _pending_ (implemented as (a)).
