# Pending decisions — Phase 5

> Open questions and owner steps from Phase 5. Answer inline (`**Owner:** …` with a date).

## Open decisions

### D-60 — `AB_OAUTH=on` is refused until the consent screen exists *(P5-01)*
- **Context:** P5-01 builds the authorization server, but the step where a person signs in and approves a client is P5-04.
  With the server on and no way to approve, `/oauth/register` would store clients nobody can use.
- **Options:** (a) parse and validate the settings now, refuse `AB_OAUTH=on` at start with a message naming P5-04, and let
  P5-04 lift the refusal; (b) allow `on` with an authorize endpoint that always answers "not available".
- **Recommendation:** (a): a boot error is clearer than a half-working feature, and nothing is exposed before it is usable.
- **Owner:** _pending_ (implemented as (a)). **Superseded by P5-04 (2026-10-24):** the built-in consent screen exists, so
  `AB_OAUTH=on` boots on both hosts. It now needs sign-in to be configured (an identity provider), because people approve
  apps with a session; without one the start is refused with a message saying so.

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

### D-64 — Protected resource metadata is the same for known, unknown and disabled workspaces *(P5-02)*
- **Context:** RFC 9728 clients fetch `/.well-known/oauth-protected-resource/w/{slug}/mcp` before they have a token. The MCP
  route answers one `401` for a wrong token, an unknown workspace and a disabled one (T19), so a metadata route that
  answered `404` for the unknown ones would list the workspaces that exist.
- **Options:** (a) one document and one challenge for every slug of valid syntax, `404` only for invalid syntax; (b) `404`
  for unknown or disabled workspaces (a database lookup per request, and an enumeration oracle).
- **Recommendation:** (a), as relic-bridge did. The document names the issuer and a resource URL the caller typed; it
  holds nothing about the workspace. An authorization request for an unknown workspace is refused at approval as before.
- **Owner:** _pending_ (implemented as (a)).

### D-65 — The metadata document is not cached *(P5-02)*
- **Context:** the document is a function of configuration, so it could carry `Cache-Control: public, max-age=…`. The app
  forces `no-store` on every response by design, and an exception would be a new rule in the security-header path.
- **Options:** (a) keep `no-store` (clients fetch it once per connection attempt, it is rate limited, and a change of
  issuer or scope applies at once); (b) add an allow-listed cacheable response.
- **Recommendation:** (a) until a client matrix run (P5-06) shows one that polls it.

### D-66 — The consent screen does not remember approvals, and has no write consent yet *(P5-04)*
- **Context:** the original scope had an opt-in "don't ask again" (30 days). relic-bridge built it and its review found
  that, with the provider's revoke-on-issue default, a remembered approval let any page disconnect a live app with one
  navigation (H1). Even without that, a remembered approval is a standing approval for a client whose name is unverified:
  anything that can send the browser to the authorize URL gets a code issued with no click.
- **Options:** (a) no remembered consent: every authorization shows the page (a code is never issued by a navigation);
  (b) build it as opt-in, never for write scopes, with the H1 fix (a new task, P5-13); (c) remember per client only for
  clients identified by a metadata document (needs P5-03's CIMD, not available for DCR clients).
- **Recommendation:** (a) now, (b) later if real clients prove too chatty (P5-06 will tell). Write consent (`mcp:write`)
  belongs to Phase 7 and would never be remembered either way.
- **Owner:** _pending_ (implemented as (a); P5-13 holds (b)).

### D-67 — Devices: at most 25 per person, and one per app, workspace and redirect address *(P5-04)*
- **Context:** each approved client + user + workspace is a device the person can see and disconnect. Without a cap a
  person (or a script holding their session) can create unbounded provider grants, and the list and "disconnect all" would
  stop agreeing with what exists (relic-bridge M2). Separately, the provider replaces a user's earlier grants of the same
  client at issue; relic-bridge moved that to the code exchange (H1) and found that installations sharing one client id and
  redirect URI (two machines of a metadata-document client) then replace each other.
- **Options:** (a) cap 25, re-checked after the insert (the oldest places win a race); replace the earlier device of the
  same client, workspace **and redirect URI** after a successful code exchange; (b) cap 100 (relic); (c) never replace, let
  devices pile up to the cap; (d) replace only when the device name matches.
- **Recommendation:** (a). 25 is far above what one person connects (phone, laptops, a few agents) and keeps the page short;
  replacement keeps "reconnect" from needing a manual disconnect. A person who connects the same app twice on purpose gives
  the second one another registration (dynamic clients register per installation) or accepts the replacement.
- **Owner:** _pending_ (implemented as (a)).
