# Pending decisions — Phase 5

> Open questions and owner steps from Phase 5. Answer inline (`**Owner:** …` with a date).

## Owner steps

Left for the owner after the Phase 5 review ([P5-10](../reviews/phase-5-review.md)); none needs a code change first.

1. **The remaining client runs** ([P6-14](../tasks/phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md)), against the real
   deployment: Claude mobile, Claude Desktop connectors, VS Code, JetBrains, Copilot CLI and MCP Inspector (Cursor and
   Windsurf when a subscription exists). Record version and date in the [client matrix](../reference/client-compatibility.md#oauth-runs-p5-06);
   evidence is the audit log (client id, grant type), never tenant content.
2. **Disconnect and reconnect, and a refresh of claude.ai**, which the 2026-10-26 runs did not cover: in claude.ai and Claude Code,
   disconnect the app on *My access*, connect it again (one device again), and let claude.ai go past the first hour so a silent
   refresh shows in the audit log.
3. **A real phone** (iOS Safari, Android Chrome): the consent page was exercised at 320 px in Chromium only.
4. **Answer D-68 and D-69 from the runs** (does a client still need dynamic registration; does one need a private-use callback):
   P5-15 holds the work if one does.
5. **The decisions below** (D-76 … D-79): D-76 is built at its recommendation in the review's PR, so say so if you would
   rather have the alternative.

## Open decisions

### D-60 — `AB_OAUTH=on` is refused until the consent screen exists *(P5-01)*
- **Context:** P5-01 builds the authorization server, but the step where a person signs in and approves a client is P5-04.
  With the server on and no way to approve, `/oauth/register` would store clients nobody can use.
- **Options:** (a) parse and validate the settings now, refuse `AB_OAUTH=on` at start with a message naming P5-04, and let
  P5-04 lift the refusal; (b) allow `on` with an authorize endpoint that always answers "not available".
- **Recommendation:** (a): a boot error is clearer than a half-working feature, and nothing is exposed before it is usable.
- **Owner (2026-10-26):** Closed. **Superseded by P5-04 (2026-10-24):** the built-in consent screen exists, so
  `AB_OAUTH=on` boots on both hosts. It now needs sign-in to be configured (an identity provider), because people approve
  apps with a session; without one the start is refused with a message saying so.

### D-61 — `resource` is required at authorization, optional at the token endpoint *(P5-01)*
- **Context:** the workspace is the RFC 8707 resource, so an authorization request without one cannot name a workspace.
  At the token endpoint, if `resource` is sent it must be ours and the grant's own; if it is left out the grant's applies.
- **Options:** (a) as described (lenient at the token endpoint, so clients that leave it out on refresh keep working);
  (b) require it on every request like relic-bridge, which fails clients that do not repeat it.
- **Recommendation:** (a): the grant already fixes the workspace, so requiring it again adds no safety and costs
  compatibility (L-094). Clients that send no `resource` at authorization need P5-02 (metadata) to learn it.
- **Owner (2026-10-26):** Decided: as recommended, (a).

### D-62 — Grant properties are encrypted by the provider, not by a keyring purpose *(P5-01)*
- **Context:** ADR-0009 promises envelope-encrypted grant properties. The provider encrypts them with a key wrapped under
  each token, so a database copy, even with the master key, cannot open them; a keyring purpose would be weaker.
- **Options:** (a) rely on the provider's scheme (no new `KeyPurpose`); (b) add a keyring purpose and encrypt again.
- **Recommendation:** (a). Props hold only ids (workspace, access grant, user, client). P5-05's refresh-reuse successor,
  which must be recoverable, gets its own derived key.
- **Owner (2026-10-26):** Decided: as recommended, (a).

### D-63 — Until P5-05, a rotated refresh token works once more *(P5-01)*
- **Context:** the provider keeps the previous refresh token valid until the new one is first used, so a lost response
  cannot strand a client. A stolen, already-rotated token therefore refreshes once more.
- **Options:** (a) accept until P5-05 adds reuse detection and the 30-second window; (b) block now with a marker per
  refresh token (relic-bridge's P5-05 design, pulled forward).
- **Recommendation:** (a): P5-05 is next, `AB_OAUTH` cannot be on before P5-04, and the window it builds replaces this rule.
- **Owner (2026-10-26):** Closed. **Superseded by P5-05 (2026-10-24):** every refresh now goes through the refresh
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
- **Owner (2026-10-26):** Decided: as recommended, (a).

### D-65 — The metadata document is not cached *(P5-02)*
- **Context:** the document is a function of configuration, so it could carry `Cache-Control: public, max-age=…`. The app
  forces `no-store` on every response by design, and an exception would be a new rule in the security-header path.
- **Options:** (a) keep `no-store` (clients fetch it once per connection attempt, it is rate limited, and a change of
  issuer or scope applies at once); (b) add an allow-listed cacheable response.
- **Recommendation:** (a) until a client matrix run (P5-06) shows one that polls it.
- **Owner (2026-10-26):** Decided: as recommended, (a).

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
- **Owner (2026-10-26):** Decided: as recommended, (a). P5-13 holds (b) for later.

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
- **Owner (2026-10-26):** Decided: as recommended, (a).

### D-68 — Dynamic client registration stays on by default, capped *(P5-03)*
- **Context:** the MCP authorization spec prefers metadata documents (CIMD) and keeps DCR as a compatibility path. DCR is an
  anonymous write endpoint, so it is the main storage and phishing surface of an OAuth deployment (T10); many clients
  (editors, CLIs, older SDKs) still only register dynamically.
- **Options:** (a) on by default with caps (10 per address and hour, 200 live, 24 h while unused, optional redirect host
  allowlist) and `AB_OAUTH_DCR=off` to close it; (b) off by default, so every deployment must opt in.
- **Recommendation:** (a): OAuth itself is opt-in (`AB_OAUTH=on`), so a deployment that turns it on wants clients to
  connect; (b) breaks the clients that cannot use CIMD without telling anyone why (L-089). Turn DCR off once the client
  matrix (P5-06) shows your clients use documents.
- **Owner (2026-10-26):** Decided: as recommended, (a); revisit after the client matrix (P5-06).

### D-69 — Private-use scheme redirects (`cursor://...`) are not usable *(P5-03)*
- **Context:** some desktop clients list a private-use scheme callback. Any local app can claim a scheme, and the provider
  itself only sends codes to https and loopback http (`allowPrivateUseRedirectUris` is off).
- **Options:** (a) drop them from registrations and documents and refuse a request left with no https or loopback
  callback; (b) turn on the provider's `allowPrivateUseRedirectUris` and accept them (PKCE protects the code, consent shows
  the callback).
- **Recommendation:** (a) now, as relic-bridge; P5-06 (client matrix) decides whether a client we want needs (b), and then
  P5-04's consent screen must show the scheme.
- **Owner (2026-10-26):** Decided: as recommended, (a); P5-06 decides whether a client needs (b) (task P5-15).

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
- **Owner (2026-10-26):** Decided: as recommended, (a). Recorded in [ADR-0017](../adr/0017-oauth-secrets-at-rest.md), which amends the secrets-at-rest sentence of ADR-0009 (with D-62).

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
- **Owner (2026-10-26):** Decided: as recommended, (a).

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
- **Owner (2026-10-26):** Decided: as recommended, (a).

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
- **Owner (2026-10-26):** Decided: as recommended, (a).

### D-75 — Who may see and end other people's connected apps, and who sees clients *(P5-08)*
- **Context:** ending a device only removes access, but seeing everyone's apps shows who works with which workspace, and a
  client is shared by the whole server.
- **Options:** (a) owners and admins list everyone's devices; an owner ends anyone's, an admin a member's (and their own),
  the same rule as ending sessions; clients are the owners' only; (b) owners only for everything; (c) admins also end
  owners' and admins' devices.
- **Recommendation:** (a): it follows the panel's existing role model (admins manage members, owners everyone), needs no new
  concept, and keeps an admin from cutting an owner's access. No recent sign-in is asked: disconnecting only removes access
  (L-093).
- **Owner (2026-10-26):** Decided: as recommended, (a).

### D-76 — At a cap, the cache gives way and the unused go first; one source can no longer hold a cap *(P5-10)*
- **Context:** the review reproduced that one address can keep both registration caps full for everyone else. Ten registrations an
  hour, each living a day while unused, is 240 live against a cap of 200; twenty metadata fetches an hour, each cached up to a
  day, is 480 against 200. At the cap every other client was refused (`429`, or `400` for a document client such as claude.ai
  whose cached document had expired). An earlier note had accepted that "many addresses together can fill the cap", not one.
- **Options:** (a) a stored metadata document is only a cache, so at the cap **evict one at random** instead of refusing, and at
  the dynamic-registration cap **remove registrations that never exchanged a code and are over an hour old** first (a bounded
  sweep of 10 records), refusing only when nothing is that old; (b) lower the per-address limits or the unused lifetime so that
  rate times lifetime stays under the cap (10 an hour for a day needs 5 an hour, or a 12 h lifetime), which changes D-68's numbers
  for every honest user; (c) keep refusing and tell operators to turn registration off when it happens.
- **Recommendation:** (a), built in the P5-10 PR (tests fail when it is reverted). It keeps D-68's numbers, bounds storage the same,
  and turns "held for a day by one address" into "held for an hour by a flood of at least the cap". The hourly deployment limit
  (100) stays under the cap (200), which is what guarantees room; raise one without the other and the guarantee is gone.
- **Owner (2026-10-27):** Decided: as recommended, (a).

### D-77 — Which access refusals at a token issuance end the device for good *(P5-10)*
- **Context:** every issuance (code exchange, refresh) re-runs the access decision, and any refusal is `invalid_grant`, on which the
  provider revokes the device's whole grant (P5-01). Most refusals are final (grant revoked or expired, person gone). Some pass:
  a workspace or instance switched off for maintenance, a person disabled for a while, a credential marked invalid until
  someone replaces it. A device token comes back to life when that is fixed; an OAuth device has to be approved again, and a
  client at its next refresh sees its tokens refused with no hint that waiting would have been enough. (Per request the access
  token is refused either way, so nothing is weakened by keeping the device.)
- **Options:** (a) keep: every refusal ends the device (simple, fail closed, today); (b) final refusals end it, recoverable ones
  (`workspace_disabled`, `instance_disabled`, `user_disabled`, `credential_revoked`, `credential_unvalidated`) answer `503
  temporarily_unavailable` and keep it, so the person is not asked to approve again after the fix; (c) never end the device on
  a refusal (an access token that is refused per request is enough).
- **Recommendation:** (b), as task P5-21. It needs care in `checkIssuance` and the repeat path of the refresh family, and the
  docs ("how it works") say what a refresh does with each reason. Not built in the review: it changes what ADR-0009's
  "revoke on refusal" means and the owner may prefer (a).
- **Owner (2026-10-27):** Decided: as recommended, (b); built as task [P5-21](../tasks/phase-5-oauth/P5-21-recoverable-issuance-refusals.md), [ADR-0018](../adr/0018-recoverable-issuance-refusals-keep-the-device.md).

### D-78 — Abuse counters key on a plain hash of the address, which an IPv4 address can be recovered from *(P5-10)*
- **Context:** the OAuth counters (`oauth-abuse:`, `oauth-dcr-ip:`, `oauth-cimd-ip:`) are keyed by the first 128 bits of SHA-256 of
  the address (an IPv6 address by its /64 network). The docs say "no address sits in storage". True as written, but the IPv4
  space is 2^32, so anyone with a copy of the database can try every address against a counter name. The rows live for one
  window (10 minutes to an hour) and the purge removes them.
- **Options:** (a) keep, and say so (pseudonymous, short-lived); (b) a keyed hash (HMAC) under a key from the master keyring, which
  the OAuth runtime does not hold today (D-70) and the Worker would read per request; (c) a random per-deployment salt in the same
  database (no protection from a copy of it, so no better than (a)).
- **Recommendation:** (a) now, with the docs corrected in the P5-10 PR; (b) as task P5-22 if the deployment's privacy position needs
  it (an address is personal data under some regimes), since it adds a key read to every limited request.
- **Owner (2026-10-27):** Decided: as recommended, (a); P5-22 stays a follow-up.

### D-79 — Go for Phase 6 *(P5-10)*
- **Context:** Phase 5 is built, reviewed (P5-10: four medium findings fixed, the rest recorded) and deployed; the unauthenticated live
  pass on 2026-10-27 matched the design. Not proven by a real client: refresh and disconnect for claude.ai, every client of
  [P6-14](../tasks/phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md), a real phone. **Dependencies per the
  [ROADMAP](../ROADMAP.md#phases-at-a-glance):** Phase 6 (tool breadth) depends only on Phase 2 and is independent of
  Phase 5; **Phase 7 (writes) depends on Phases 2, 4 and 5, not on Phase 6**, and its review (P7-09) needs P5-10 to verify the
  `mcp:write` scope end to end; Phase 8 needs both 6 and 7. So starting Phase 6 does not unlock Phase 7: P5-10 does, once
  merged.
- **Options:** (a) go now: start Phase 6, and run P6-14 and the owner steps above in parallel with it; (b) go after the owner
  steps (client runs, disconnect and reconnect, a phone); (c) hold Phase 6 for the follow-ups (P5-13 … P5-16, P5-19 … P5-22).
- **Recommendation:** (a). Phase 6's tools need no OAuth change, P6-14 is already its own task, and a client defect in the matrix
  shows up at the run whatever the order. Treat the follow-ups as priority work, not a gate. Take Phase 7 in whichever order
  suits: it needs P5-10 merged, not Phase 6.
- **Owner (2026-10-27):** Decided: as recommended, (a), go for Phase 6 now (built and reviewed in P6-01 … P6-13).

### D-131 — Device last-used time is a throttled `kv` row, and a device without one is not idle *(P5-14)*
- **Context:** a person cannot tell which connected app is still used, and a forgotten or phished approval lives for the whole
  refresh lifetime. The provider rewrites grant metadata on every refresh, and a write per MCP request would put storage on
  the hot path.
- **Options:** (a) a `kv` row per device (`oauth-used:<user>:<grant>`, a timestamp only), written at token issuance and at most
  every 5 minutes per device and process on MCP requests, deleted with the device; a device with no row is treated as not idle;
  (b) keep it in grant metadata (rewritten by the provider, races with refresh rotation); (c) a column on a new table (a
  migration and a table for a value that expires with the device).
- **Recommendation:** (a). The cost is one write per device per isolate per interval, and a last-used time that can be 5 minutes
  late. A missing row (approved before the switch, or expired) starts counting at the next refresh instead of ending the device,
  so switching `AB_OAUTH_IDLE_TTL` on never disconnects people at once.
- **Owner (2026-10-29):** Decided: as recommended, (a).

### D-132 — The operator view of OAuth abuse is owner-only and counts audit rows *(P5-20)*
- **Context:** the task asked for "administrators only". Registration caps and per-surface refusals are deployment-level facts, and the
  OAuth apps page that lists clients is already owner-only. A limit is audited once per window, so the audit is a count of windows
  in which a limit was reached, not of refused requests; the exact counters expire with their window.
- **Options:** (a) owners only, counts of audit rows, said plainly on the page; (b) owners and admins; (c) exact request counts from a
  new durable counter per refusal (a write per refused request, the opposite of what the once-per-window audit avoids).
- **Recommendation:** (a): same audience as the client list, no new writes. (b) is one line (`authorizeClients` becomes manager-level)
  if the owner wants administrators to see it; (c) only if windows prove too coarse to tune from.
- **Owner (2026-10-29):** Decided: as recommended, (a).

### D-133 — The document host allowlist matches exact host names *(P5-16)*
- **Context:** `AB_OAUTH_CIMD_HOSTS` lets an operator accept metadata-document clients only from known hosts. A client's document host is
  not always its product's apex (a client may publish under a subdomain).
- **Options:** (a) exact host names only; (b) also `*.example.org` wildcards; (c) a registrable-domain match (needs a public suffix list).
- **Recommendation:** (a): the list is a security control, and a suffix or wildcard match widens it to hosts nobody reviewed (anyone can
  publish under a shared domain). List each host; add a wildcard only if a real client needs one.
- **Owner (2026-10-29):** Decided: as recommended, (a).
