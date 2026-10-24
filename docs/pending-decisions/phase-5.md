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
- **Owner:** _pending_ (implemented as (a)). **Superseded by P5-05 (2026-10-24):** every refresh now goes through the refresh
  family ([D-70](#d-70--refresh-successors-are-sealed-under-a-key-derived-from-the-spent-token-p5-05)): a spent token is
  answered with the same successor for the reuse window (default 30 s) and revokes the device after it; the provider's
  "previous token" rule is never reached for a token we have seen spent.

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

### D-68 — Dynamic client registration stays on by default, capped *(P5-03)*
- **Context:** the MCP authorization spec prefers metadata documents (CIMD) and keeps DCR as a compatibility path. DCR is an
  anonymous write endpoint, so it is the main storage and phishing surface of an OAuth deployment (T10); many clients
  (editors, CLIs, older SDKs) still only register dynamically.
- **Options:** (a) on by default with caps (10 per address and hour, 200 live, 24 h while unused, optional redirect host
  allowlist) and `AB_OAUTH_DCR=off` to close it; (b) off by default, so every deployment must opt in.
- **Recommendation:** (a): OAuth itself is opt-in (`AB_OAUTH=on`), so a deployment that turns it on wants clients to
  connect; (b) breaks the clients that cannot use CIMD without telling anyone why (L-089). Turn DCR off once the client
  matrix (P5-06) shows your clients use documents.
- **Owner:** _pending_ (implemented as (a)).

### D-69 — Private-use scheme redirects (`cursor://...`) are not usable *(P5-03)*
- **Context:** some desktop clients list a private-use scheme callback. Any local app can claim a scheme, and the provider
  itself only sends codes to https and loopback http (`allowPrivateUseRedirectUris` is off).
- **Options:** (a) drop them from registrations and documents and refuse a request left with no https or loopback
  callback; (b) turn on the provider's `allowPrivateUseRedirectUris` and accept them (PKCE protects the code, consent shows
  the callback).
- **Recommendation:** (a) now, as relic-bridge; P5-06 (client matrix) decides whether a client we want needs (b), and then
  P5-04's consent screen must show the scheme.
### D-70 — Refresh successors are sealed under a key derived from the spent token, not under the master key *(P5-05)*
- **Context:** the reuse window answers a repeat of a just-spent refresh token with the same successor, so the successor
  (new refresh token and access token) must be recoverable for up to 120 s. ADR-0009 says a recoverable transient secret
  is envelope-encrypted, and D-62 expected "its own derived key". The OAuth runtime has no keyring (it holds no master
  key, and the Worker's request path would need one more secret read per refresh).
- **Options:** (a) AES-256-GCM under a key derived (HKDF-SHA-256) from the spent refresh token itself, bound to its hash:
  only a holder of the token that is allowed to ask can open the row, the database and its backups hold nothing that
  opens it, and no key is stored, rotated or lost (L-074 holds trivially); (b) a keyring purpose under the master key (the
  database plus the master key opens every sealed successor in the window; the runtime needs the keyring; a master-key
  rotation has to rewrite or drop live rows); (c) store the successor in clear for the window (refused by ADR-0009).
- **Recommendation:** (a). It is stronger against the threat the seal exists for (a stolen database or backup) and needs no
  new key plumbing. It does not defend against someone who holds the spent token, who by the window's definition may ask
  for the successor anyway. The sealed row lives for the window only; the rotation marker (a hash and a time) lives for the
  refresh lifetime so a late replay is recognised.
- **Owner:** _pending_ (implemented as (a)).

### D-72 — OAuth abuse counters are fixed windows in the shared `kv` table, and fail open *(P5-09)*
- **Context:** the limits must be exact across Worker isolates and replicas (L-081) and cheap on D1's Free plan (L-097),
  and P5-03 already counts registrations and fetches with `kv.increment` and `max`. The general per-IP limiter is a token
  bucket per isolate.
- **Options:** (a) fixed-window counters in `kv` for every OAuth surface (one design, atomic, no new table), with the
  isolate remembering refused counters and audit markers, failing open when the store errors; (b) a Durable Object limiter
  (exact, billed per call, new binding); (c) token buckets in `kv` (read-modify-write, not atomic on D1, or a CAS loop);
  (d) fail closed when the counter store is down.
- **Recommendation:** (a). Fixed windows allow up to twice a limit around a boundary, which these limits (abuse, not
  quotas) tolerate; (d) would turn a D1 hiccup into a sign-in outage when the request needs the same storage anyway.
  Windows are 10 minutes for the interactive endpoints and an hour for registration and fetches.
- **Owner:** _pending_ (implemented as (a)).

### D-73 — Defaults and the shape of the deployment-wide caps *(P5-09)*
- **Context:** every deployment-wide cap can be reached by many addresses together and then refuses honest users until the
  window ends. The defaults trade that risk against the cost of a flood (D1 writes on Free, outbound fetches, rows).
- **Options:** (a) per address 30 authorize / 30 consent / 20 token failures per 10 minutes; deployment 600 / 300 / 300;
  100 registrations and 200 fetches per hour; the token-failure deployment cap refuses only addresses that already
  failed; (b) per-address limits only, no deployment caps (a botnet is then bounded only by the edge); (c) stricter
  defaults (10 / 10 / 5).
- **Recommendation:** (a). Real use is a few authorizations per person per day, so the address limits leave room for a
  shared office address (a 10-person team connecting at once is well within 30 per ten minutes) while the deployment caps stop
  sustained floods at a bounded number of writes. Raise `AB_OAUTH_*_LIMIT` for a large organisation behind one address.
- **Owner:** _pending_ (implemented as (a)).

### D-74 — A revoked dynamic client may register again, as a new client; a revoked metadata-document client stays refused until allowed *(P5-08)*
- **Context:** an owner revokes an OAuth client that turned out to be hostile or abandoned. A dynamic client's id is chosen by
  the server, so an app that registers again is a different client with a new random id; a metadata-document client's id is
  its public URL, so the same app can present itself again at once.
- **Options:** (a) revoke the id (block row, record deleted, devices ended); dynamic registration stays open and the owner
  may switch it off (`AB_OAUTH_DCR=off`) or narrow redirect hosts; a document client stays blocked until the owner restores
  it; (b) also block by name or redirect host (cheap to evade, and it would block honest apps that share a host such as
  `127.0.0.1`); (c) revoking a dynamic client turns dynamic registration off until the owner turns it back on.
- **Recommendation:** (a). Names are unverified and loopback hosts are shared by every desktop app, so blocking on them
  hurts honest users and stops no one; the real controls for a hostile registrant are the consent screen, the redirect host
  allowlist and the caps of P5-03 and P5-09. The block of a dynamic client expires once every token it could hold has.
- **Owner:** _pending_ (implemented as (a)).

### D-75 — Who may see and end other people's connected apps, and who sees clients *(P5-08)*
- **Context:** ending a device only removes access, but seeing everyone's apps shows who works with which workspace, and a
  client is shared by the whole server.
- **Options:** (a) owners and admins list everyone's devices; an owner ends anyone's, an admin a member's (and their own),
  the same rule as ending sessions; clients are the owners' only; (b) owners only for everything; (c) admins also end
  owners' and admins' devices.
- **Recommendation:** (a): it follows the panel's existing role model (admins manage members, owners everyone), needs no new
  concept, and keeps an admin from cutting an owner's access. No recent sign-in is asked: disconnecting only removes access
  (L-093).
- **Owner:** _pending_ (implemented as (a)).
