---
id: P5-03
title: "Client registration: CIMD and DCR"
phase: 5
status: done
priority: high
depends_on: [P5-02]
adr: ["0009"]
lessons: [L-088, L-089, L-091, L-097, L-121, L-242]
owner: "claude-agent"
---

# P5-03 — Client registration: CIMD and DCR

> Refined 2026-10-24 (tasks/README rule 7), after P5-01 and P5-02 and relic-bridge's P5-03 and its Phase 5 review
> (findings M1 and L4 folded in; L9 is already covered by the display-name rules).

## Goal
MCP clients identify themselves to the authorization server without an operator registering them, through Client ID
Metadata Documents (CIMD, preferred by the MCP 2025-11-25 and 2026-07-28 revisions) and Dynamic Client Registration
(RFC 7591, the compatibility path), both hardened against SSRF, redirect-URI abuse and registration floods. The caps are
settings P5-09 tunes; the consent screen that displays client metadata is P5-04.

## Scope
- **CIMD resolved by us, not by the provider** (ADR-0009): the provider's own CIMD stays off (it follows redirects, needs the
  Workers flag and caches in the Cache API). A validated document is stored as the provider's client record
  (`client:<url>`, bounded TTL, shared storage, never isolate memory) so the provider's lookup, redirect matching and
  grants work unchanged.
  - Off unless the host gives a guarded fetcher; `client_id_metadata_document_supported` in the metadata follows. Node:
    undici dispatcher whose connect-time lookup refuses any non-public address (every resolved address checked, the P2-19
    and P4-01 guard); Workers: `global_fetch_strictly_public` (set in `wrangler.jsonc`, read from the runtime) plus
    `redirect: manual`; without the flag CIMD stays off and DCR remains.
  - `client_id` checked before any fetch: canonical https URL (`URL.href` equals the string), a path, no userinfo,
    fragment or port, a DNS name with a dot (no IP literal, no internal suffix), not the issuer's own host, 512 characters.
  - Fetch: GET, no redirects, 5 s for the whole exchange, 200 and a JSON media type only, 5 KiB (declared and streamed).
  - Document: JSON object; `client_id` equals the URL; display name rules; no `client_secret*`; `token_endpoint_auth_method`
    `none`; redirect URIs kept only if `https` on the client id's host or `http` on loopback (RFC 8252), none left = refused.
  - Cache: `Cache-Control` clamped to 5 min - 24 h (1 h default); errors never cached. Resolved at `/oauth/authorize` and
    at `/oauth/token`, before a code is consumed.
  - Abuse bounds (T11, relic L4): at most `AB_OAUTH_CIMD_MAX_CLIENTS` stored document clients (default 200) and
    `AB_OAUTH_CIMD_FETCH_LIMIT` fetches per address and hour (default 20, an atomic `kv.increment`), counted before the fetch.
- **DCR (RFC 7591)**, `AB_OAUTH_DCR` `on` (default, D-68) | `off`:
  - The request is parsed and **rebuilt** before the provider sees it: only `redirect_uris`, `client_name`,
    `token_endpoint_auth_method` (`none`, `client_secret_basic`, `client_secret_post`), `grant_types`, `response_types` pass;
    everything else (`logo_uri`, `jwks_uri`, `software_statement`, contacts, ...) is dropped, so nothing the client names
    is ever fetched or shown. 1-10 redirect URIs, 2,000 characters each, no fragment, wildcard, userinfo or whitespace;
    `https` on a DNS name or `http` on loopback; private-use schemes are not usable (D-69); optional host allowlist
    `AB_OAUTH_DCR_REDIRECT_HOSTS`; name rules as for CIMD (controls, bidi, look-alike scripts).
  - Caps, in this order (relic M1: a single source must not lock out the rest): per address and hour
    `AB_OAUTH_DCR_IP_LIMIT` (default 10, atomic `kv.increment` with `max`), then live registrations per deployment
    `AB_OAUTH_DCR_MAX_CLIENTS` (default 200, counted in storage). Over either: `429` with `Retry-After`.
  - Unused registrations die young (`AB_OAUTH_DCR_UNUSED_TTL`, default 24 h); the first token exchange renews them to the
    registration lifetime (the provider's half-life rule). `registrations.sweep()` deletes expired records the store has not
    purged yet, called by the host housekeeping (P5-09 can call it on its own schedule).
- **Audit** `oauth.client.registered` and `oauth.client.refused` (cap reached, per address) for DCR, `oauth.client.fetched` and
  `oauth.client.refused` for CIMD fetches that went out; ids, host and a stable reason only, never the document.
- Consent seam: `OAuthAuthorizationRequest` gains `clientKind` (`metadata_document` | `dynamic`) and `clientHost` for P5-04. Client
  names are checked on the way in and stay untrusted text for every output path (L-038).

## Acceptance criteria
- [x] CIMD happy path (a Claude-style document with a loopback redirect and an https redirect on its own host) completes
  authorize, token and an MCP call on Node (memory, SQLite) and workerd (D1).
- [x] Refused with a `400 invalid_client` and no redirect: IP literals (decimal, hex, IPv6 forms), internal names, userinfo,
  ports, fragments, non-canonical ids, own host; redirects, wrong media type, oversized (declared and streamed) and slow
  documents, `client_id` mismatch, secrets, foreign-host, fragment and wildcard redirects; nothing is fetched for a refused id.
- [x] Node fetcher refuses loopback, private, link-local, metadata, CGNAT, ULA and mapped addresses at connect time, including
  a name that resolves to one (DNS rebinding) and a name with a public and a private record; Workers fetcher is off without the flag.
- [x] DCR validation matrix (redirect schemes and hosts, wildcards, sizes, auth methods, grant types, dropped fields), the
  per-address and the deployment caps (429, shared storage), expiry of unused clients, allowlist, switch off, audit rows.
- [x] Negative authorization: a refused client gets no code, no token, no Agility request.
- [x] Security tests are mutation-checked (L-121), recorded under Outcome.
- [x] `docs/dev/oauth.md`, THREAT_MODEL T10 and T11, RESEARCH, the configuration reference, a changeset and new lessons.

## Outcome
- Built as scoped. Defaults: DCR on and capped (D-68), private-use scheme redirects not usable (D-69), CIMD on wherever the
  host has a guarded fetcher (always on Node; on Workers through `global_fetch_strictly_public`, now in `wrangler.jsonc`).
  New settings `AB_OAUTH_CIMD*` and `AB_OAUTH_DCR*` (see the configuration guide); the caps are the knobs P5-09 tunes.
  `HttpApp.oauthRegistrations` (`count`, `sweep`) are the cleanup hooks.
- relic-bridge findings folded in: M1 (one address cannot lock out registration: per-address atomic counter first, cap on
  live clients instead of a global window), L4 (stored document clients and fetches per address are capped), L9 (look-alike
  names refused on the way in); the whole refusal text is one generic sentence and the CIMD cache is the provider's own
  client record in shared storage.
- Checked against draft-ietf-oauth-client-id-metadata-document-02: stricter than the draft on ports (refused) and shared-secret
  methods (document refused, not only ignored); the draft's loopback exception for fetching is not used.
- Suites: shared client suite on memory (also the Workers shape), SQLite and workerd/D1 (workerd runs every sixth row of
  the refusal matrices: each case starts a Worker), 106 policy and fetch unit cases, memory-only settings and caps cases
  with time travel, the Node fetcher over real local HTTP (redirect, oversize, endless, slow, stalled) and the public-only
  guard with 22 non-public destinations and a replaced resolver (mixed and changing answers).
- Mutation checks (L-121), each reverted, number of failing tests: id IP literal (6), canonical form (10), internal suffix (6),
  redirect accepted (1), size cap (2), `client_id` mismatch (4), foreign-host callback kept (5), wildcard (6), remote http
  callback (7), content type (3), `client_secret` (4), DCR raw body forwarded (2), DCR auth-method allowlist (1), per-address
  DCR cap (3), live DCR cap (1), unused lifetime (2), fetch budget (3), stored-document cap (1), cap audit once per window (6).
  Survivors, all equivalent because the provider enforces the same rule independently (L-242): `cimd === undefined` check
  (the document client then fails inside the fetch call and is refused the same way), DCR switch (the provider answers
  404 without a registration endpoint), KV adapter guard for keys the store cannot hold (the provider turns the error into a 400).
- Not covered: a real client (P5-06); the workerd fetch with the real flag against the network (no outward calls).
- New: lessons L-250 to L-252, decisions D-68 and D-69, tasks P5-15 and P5-16.

## Security notes
THREAT_MODEL T9, T10, T11, T20.

## Lessons applied
- L-088 - Client metadata fetching is an SSRF surface.
- L-089 - Dynamic registration is a compatibility path.
- L-091 - Validate redirect targets after parsing.
- L-097 - Design for the Free plan limits (a fetch is a subrequest: per-address budget, one fetch per resolution).
- L-121 - Negative authorization is first-class.
- L-242 - A library's own rule is not a test of ours.

## Docs to update
- docs/dev/oauth.md, docs/THREAT_MODEL.md, docs/RESEARCH.md, docs/guide/configuration.md, docs/pending-decisions/phase-5.md

## Out of scope
- The consent screen that shows client metadata (P5-04); the admin list, removal and runtime switch of clients (P5-08);
  rate limits beyond the caps here (P5-09).
- `private_key_jwt` and `jwks_uri` clients, logo prefetching (`logo_uri` is dropped), private-use scheme redirects (D-69).
