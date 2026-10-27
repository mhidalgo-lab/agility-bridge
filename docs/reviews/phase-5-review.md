# Phase 5 review

- **Scope:** all Phase 5 code (P5-01 … P5-09 and the follow-up tasks P5-13 … P5-20 as filed): the OAuth 2.1 authorization server
  on both hosts (`packages/http-app/src/oauth/*`, `apps/cli`, `apps/worker`), protected resource metadata, client registration
  (Client ID Metadata Documents and dynamic registration), the consent screen and devices, the refresh family, the admin pages
  for connected apps and clients, the abuse controls, and the OAuth documentation and client matrix (P5-06, P5-07).
- **Date:** 2026-10-27. **Branch:** `task/P5-10-phase-5-review`, on top of `main` after #115 (`c9a915e`).
- **Method:** an independent, adversarial read of the code against the questions in the task (the per-task reviews inside P5-01
  … P5-09 were not repeated), every claim reproduced with a throwaway test against local fakes (no real tenant, no Cloudflare
  account, no secrets). Each reproduced issue has a regression test that fails with the fix reverted (L-121); the mutations were
  run one at a time (two run in parallel on one file interfered with each other and were repeated). A live pass against the real
  deployment, limited to unauthenticated, read-only requests. The hostname is not recorded anywhere in the repository.
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test` `pnpm tasks index` and `pnpm lint` pass, `pnpm typecheck` passes, and `pnpm test` passes in full: 136 files, 2,752 tests passed, 1 skipped (the offline documentation tests that failed in the P5-09 run passed here).

## Verdict

**Ready for Phase 6, with the owner's client runs still to do.** No high finding. Four medium findings were reproduced and fixed:
one source could hold both registration caps for everyone else (and a revocation request kept unused registrations alive for 90
days), a passing failure to fetch a client's document made SDK clients throw away their tokens, and the OAuth limits could be
walked around with IPv6 addresses. Two low findings were fixed, two follow-up tasks and four decisions recorded. The design held
up where the per-task reviews concentrated: PKCE, audience binding, the single-use code, the refresh family, the consent form,
storage and isolation. What no run has shown yet is a real client other than claude.ai web and Claude Code (P6-14).

## Findings

Severity is for the deployment the project targets (a small team's server on the internet). Every item says how it was
reproduced.

### Medium

**M1 — A revocation request kept an unused dynamic registration alive for 90 days** — **fixed.** The provider renews the
registration of any client that gets a `200` from its token endpoint, and an RFC 7009 revocation answers `200` to anything.
Reproduced: register a public client, `POST /oauth/token` with `client_id` and `token=a:b:c`; the stored record's lifetime went
from 86,400 s to 7,776,000 s and the record was still there 25 hours later. This defeated the unused lifetime (D-68), the sweep
built on it (P5-09) and the registration cap: one address could fill the cap and keep it full indefinitely with one extra request
per registration. Fix: `token()` remembers the stored record of a still-unused registration before a revocation request and puts
it back if the provider renewed it (`unusedRegistrationOf`, `keepUnused`); only a code exchange renews. Test:
`clients-suite.ts` (all hosts) for a public and a confidential client and for a used one that must keep its long lifetime;
mutation-checked (the restore removed: fails on memory and in the Workers shape). Lesson L-265.

**M2 — One address could hold the registration caps for everyone else** — **fixed.** Reproduced twice. Documents: 20 fetches an
hour per address, each cached up to a day by the document's own `Cache-Control`, is 480 against a cap of 200; one address filled
the cap in ten hours and a new client (a stand-in for claude.ai after its cached document expired) got `400 invalid_client`.
Dynamic clients: 10 an hour per address for a 24-hour unused lifetime is 240 against 200; in a loop, one address reached the cap
in 18 hours and other addresses got `429` from then on. The P5-03 and P5-09 notes accepted that "many addresses together" can
fill the cap, not one. Fix (D-76): at the document cap one stored document, chosen at random, is evicted instead of refusing
(a stored document is only a cache: its next request fetches again; audited once per window as `oauth.client.evicted`); at the
registration cap a bounded sweep of 10 records first removes registrations that never exchanged a code and are over an hour
old. Tests: `clients-memory.test.ts` (eviction, one address filling the cap with long-cached documents, the sweep protecting
fresh and used registrations, one address registering at its limit for 40 hours while another still registers); each
mutation-checked. The hourly deployment limit (100) staying under the cap (200) is what guarantees the room; the settings docs
say so. Lesson L-266.

**M3 — A passing failure to fetch a client's document signed people out** — **fixed.** At the token endpoint every reason a
document could not be had (the client's server answered `503`, the fetch timed out or failed, our fetch budget was spent) was
`400 invalid_client`, and the MCP SDK answers `invalid_client` by discarding the registration and tokens and starting the whole
authorization again (`auth()` in `@modelcontextprotocol/client`, read in the installed package). With the document cache lasting
5 minutes to a day and the access token one hour, a short outage of a client's host, or a flood that used up the fetch budget,
made refreshes fail as client errors. Fix: at the token endpoint a document that is down is `503 temporarily_unavailable` with
`Retry-After`, a spent budget is `429`, and only verdicts on the client (the document names another client, is invalid or is
gone with a `4xx`) stay `invalid_client`; the authorization endpoint keeps its `400` page, and the passing answers are not counted
as the client's failures. Tests: `clients-suite.ts` (503, 500, 502, 429 versus a mismatching, malformed and missing document),
`clients-memory.test.ts` (the budget); mutation-checked (5 failing). Lesson L-267. D-77 asks the same question for the access
refusals a refresh makes.

**M4 — The OAuth limits could be walked around with IPv6 addresses** — **fixed.** The general limiter counts an IPv6 address by
its /64 network (P2-17); the OAuth counters of P5-09 were keyed by the exact address. Reproduced: 40 authorization requests from
40 addresses of one /64 against a limit of 30 were all served. One host could stay under every per-address limit and use up the
deployment-wide authorization and consent caps (600 and 300 per ten minutes), which refuse everyone, so nobody could connect an app.
Fix: `callerKey` uses `addressKey` (`/64`, IPv4-mapped as IPv4) before hashing. Test: `abuse.test.ts` rotates addresses inside one
network for authorization and registration, and checks that another network, an IPv4 address and its mapped spelling are separate
callers; mutation-checked. Lesson L-268.

### Low

**L1 — `Bearer <OAuth token>` in free text left the secret visible** — **fixed.** Reproduced with a throwaway test: the `Bearer`
pattern stops at a colon, so `Bearer usr_…:<grant>:<secret>` became `Bearer [REDACTED]:<grant>:<secret>`, and the token pattern
that runs next needs all three parts. Nothing logs a bearer value today (the suites scan every log line and audit row for one), so this was
latent, like the sign-in values of the Phase 4 review. The pattern now takes the colons. Test in `redact.test.ts`,
mutation-checked. Lesson L-269.

**L2 — The admin Connect page called OAuth a later release** — **fixed.** "Needs OAuth (a later release) … no snippet yet" a phase
after OAuth shipped. Now it says to add the endpoint as a connector and approve it in the browser, and to ask whether OAuth is on.
Test in `connect-screens.test.tsx`, mutation-checked. Lesson L-270.

**L3 — The docs said no address sits in storage; an IPv4 address can be recovered from its hash** — **documented, follow-up.**
Reproduced by reading `callerKey`: the counter name is the first 128 bits of SHA-256 of the address, and the IPv4 space is 2^32.
The rows live for one window. THREAT_MODEL T25 is corrected, `dev/oauth.md` says "pseudonymous, short-lived", and a keyed hash is
D-78 and task P5-22 (it needs a key the OAuth runtime does not hold).

**L4 — The operator guide did not say that the OAuth limits need `AB_TRUSTED_PROXY_HOPS` behind a proxy** — **documented.** Without
it every request has the proxy's address, so the per-address limits become one shared limit. A step was added to *Before you start*.

### Recorded, not changed

**R1 — Any refusal at a token issuance ends the device for good (D-77, P5-21).** A workspace switched off for maintenance, a person
disabled for a while or a credential replaced a day later costs every connected app its approval at its next refresh: the access
decision refuses, the provider revokes the grant on `invalid_grant`. Nothing is weakened (every MCP request is refused anyway while
the reason holds); the person has to approve again and gets no hint that waiting would have been enough. Changing it changes what
ADR-0009's "revoke on refusal" means, so it is a decision with a task, not a fix in a review.

**Accepted, now written down:**

- A page on another site can send a visitor's browser to `/oauth/authorize` and use up that address's 30 requests per ten minutes
  (a nuisance, bounded by the window), and can flush the visitor's open consent handles (at most 20 are kept).
- `prompt=none` tells any registered redirect whether the visitor has a sign-in session here (`login_required` or
  `consent_required`), as OIDC specifies; it never issues a code (L-090).
- A flood of at least the registration cap within an hour can still refuse registrations for that hour (the hourly deployment limit,
  100, is below the cap, 200; the document cap is no longer refusing at all).

## Checked and sound

Each was read in the code and, where the claim is a behaviour, reproduced or confirmed by the existing suites on memory, SQLite and
workerd.

- **Authorization.** PKCE S256 is required of every client by us (the provider insists only for public ones); the verifier shape
  is checked before the code is spent; `resource` is exactly one of our per-workspace URLs and the grant's own at the exchange;
  `iss` comes from configuration, never from `Host`; the redirect URI must match a registered one (the provider matches any port
  on loopback, RFC 8252; the consent page shows the full address); errors before the client is validated are `400` pages, never
  redirects (a missing, unknown or invalid `client_id` also live, below); `prompt=none` never issues a code; the consent form
  needs a session, fetch metadata, `Origin`, one CSRF token and a single-use handle bound to the exact request and the person,
  its CSP forbids framing and widens `form-action` by one origin only (`formActionSource` takes `URL.origin`, so a `;` in a
  redirect path cannot add a directive); an approval re-runs the access decision and the device cap under a per-person lock.
- **Token endpoint.** One code, one exchange (`kv.take` before the provider; a replay revokes the grant, a forged token of a real
  device revokes nothing); form-encoded, no repeated parameter, bodies capped; the refresh family has one spender per token (claim,
  re-read, rotate), a sealed successor under a key derived from the spent token (AES-GCM, random IV, bound to the token's hash), a
  repeat inside the window authenticated through the provider and bound to the client, resource and scope, a repeat after it
  revoking the device; the successor is gone after the window and the marker stays; a tombstone is written before every revoke and
  read before and after the provider rotates.
- **Revocation on every path.** My access (one, all), administrator, client revoke (block first), a replayed code, a reused refresh
  token, a refused issuance, RFC 7009; a disabled person, a revoked grant, a disabled workspace and a revoked credential end access
  per request; the access cache is cleared by the revoking process and ends by itself elsewhere within `AB_ACCESS_CACHE_TTL` (60 s at
  most, never past the token's expiry), and refresh has no cache.
- **Registration.** A dynamic request is rebuilt from an allowlist of fields; redirect URIs are parsed and held to https on a DNS
  name or loopback http; names are checked for control, format and mixed-script characters; a document client id is canonical, https,
  a DNS name, no port, not ours, fetched without redirects, 5 s, 5 KiB, JSON, and must name exactly its own URL, so another
  host's cache entry cannot be poisoned. The Node fetcher refuses non-public addresses at connect time (every answer of the lookup);
  the Worker relies on `global_fetch_strictly_public` (present in `wrangler.jsonc`, read from the runtime, CIMD off without it).
- **Abuse controls.** Counters are atomic, address first then deployment, a refused counter is remembered in the isolate, and the
  store failing lets the request through; the address is taken from `cf-connecting-ip` on the Worker and from `X-Forwarded-For` only
  with `AB_TRUSTED_PROXY_HOPS` on Node.
- **Storage.** Codes and tokens are stored as hashes, grant properties are encrypted by the provider, the sealed successor holds no
  secret a database copy can open; every `kv` read and list ignores expired rows, and a job removes them (Worker cron, hourly on Node).
- **Isolation.** A token for one workspace is refused at another (audience, props, slug, access cache key); one person's device is a
  `404` for another; an administrator ends a member's device, an owner anyone's, clients are the owners' (`guardedServices.oauth`).
- **Web-standard only, per-request state.** No `node:*`, `process` or `Buffer` in `core`, `auth`, `http-app` or `admin-ui`
  (`check-runtime-imports` in `pnpm lint`); the OAuth runtime holds configuration and completed values only (the provider module, the
  per-resource server objects, the refused-counter memory); the claim and every marker live in storage, and no in-flight promise is shared.
- **Logs.** Every OAuth log line carries stable reasons, ids and counts; the provider's `onError` is reduced to code, status and reason.

## Matrix re-check

The OAuth runs table, the P5-06 outcome, the guides and P6-14 agree. Fixed: the matrix said "no client has used dynamic
registration yet" while the Phase 0 spike (MCP Inspector) did: it now says "against this release". The claude.ai guide says what
the run covered (refresh after the first hour and disconnect and reconnect were not), and P6-14 now lists claude.ai's refresh,
which the matrix marks "not run" and no task carried. Nothing claims "verified" without a version, a date and a run: claude.ai web
and Claude Code 2.1.310 on 2026-10-26 are the only OAuth runs against this release; VS Code, MCP Inspector and Claude Code 2.1.304
are Phase 0 spike results (P0-08, 2026-10-21, a different build) and are labelled so.

## Live verification (2026-10-27)

Unauthenticated, read-only requests against the real deployment (its version was not part of the checks; the review's fixes are not
deployed). No registration, no authorization that completes, no tool call, no admin token; `/oauth/register` was not called. The hostname is
not recorded here.

| Check | Result |
|---|---|
| `GET /health` | `200 {"status":"ok"}`; `Cache-Control: no-store`, HSTS (`max-age=31536000; includeSubDomains`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, an `X-Request-Id` |
| `GET /.well-known/oauth-authorization-server` | `200`; `issuer` is the public origin; authorization, token, registration and revocation endpoints on it; `code_challenge_methods_supported: ["S256"]`; `authorization_response_iss_parameter_supported: true`; `client_id_metadata_document_supported: true`; `scopes_supported: ["mcp:read","offline_access"]`; no `protected_resources` list |
| `GET /.well-known/oauth-protected-resource/w/<made-up slug>/mcp` | `200`; `resource` is the issuer's `/w/<slug>/mcp`, one authorization server, `scopes_supported: ["mcp:read"]`, header bearer only: the same document for a workspace that does not exist (T19) |
| `POST /w/<made-up slug>/mcp`, no token | `401 {"error":"unauthorized"}` with `WWW-Authenticate: Bearer realm="agility-bridge", resource_metadata="…/.well-known/oauth-protected-resource/w/<slug>/mcp", scope="mcp:read"` |
| A `Host` header that is not ours | `403` from the Cloudflare edge (an HTML page; the request never reaches the Worker) |
| `GET /oauth/authorize` with no `client_id` | `400 {"error":"invalid_request","error_description":"client_id is required"}`, no `Location` |
| `GET /oauth/authorize` with a `client_id` that does not exist (and a loopback `redirect_uri`, `state`, PKCE and the resource) | `400 {"error":"invalid_request","error_description":"Invalid client_id"}`, no `Location`: nothing was redirected |
| `GET /oauth/token` | `404 {"error":"not found"}` (the route is `POST` only), with the same security headers |

All matched the design and the operator guide's "check it works". The new `Retry-After`, eviction and `503` behaviours need the fixes
deployed and were checked locally only.

## Per-task completeness

| Task | PR | Status | Evidence / gap |
|---|---|---|---|
| P5-01 OAuth server | #103 | met | 32 conformance cases on memory, SQLite and workerd; M1 and M3 are provider behaviours it did not test |
| P5-02 protected resource metadata | #104 | met | checked live (above) |
| P5-03 client registration | #106 | met | M1, M2, M3 found here; caps now evict or free (D-76) |
| P5-04 consent and devices | #105 | met | handle, CSRF, framing, cap re-read; real phones are an owner step |
| P5-05 token lifecycle | #108 | met | the refresh family held up under a hostile read; R1 is its refusal policy |
| P5-06 client matrix | #114 | met | two clients run; the rest is P6-14 |
| P5-07 OAuth docs | #115 | met, set to `done` here | commands and the real-deployment checks were run in P5-07 and again above |
| P5-08 admin OAuth apps | #109 | met | roles re-read against `guardedServices` |
| P5-09 abuse controls | #107 | met | M4 found here (address keying); T25 corrected |
| Follow-ups | — | open | P5-13 … P5-16, P5-19, P5-20 (filed by P5-04, P5-03, P5-09) and P5-21, P5-22 (new); none blocks Phase 6 |

## Bookkeeping

- Every Phase 5 task is `done` or an open follow-up (`todo`): P5-07 was `review` and is `done` (its PR #115 is merged); P5-10 is
  `review` until this PR merges. No unticked box is left in a done task (checked by script).
- The Phase 5 lessons L-242 … L-264 were listed under theme J in the index but sat in the section for logging (P): the anchor
  went to the wrong place. They are moved into J, in the order they were written; the new lessons L-265 … L-270 are filed under
  their themes (J, I, P, K) and the index. The numbering test passes.
- Decision numbers D-60 … D-75 are used once each except **D-71, which was never used** (a gap, like the D-38 and D-48 … D-54 gaps of
  Phase 4; history is not renumbered). Task numbers P5-17 and P5-18 are likewise unused. D-60 and D-63 are closed as superseded
  in their own entries. D-76 … D-79 are new.
- THREAT_MODEL: the §8e status sections of P5-08, P5-09 and P5-10 follow §9 (*Maintenance*) in the file. The content is current;
  the order is cosmetic and is not moved here.

## New lessons, decisions and tasks

- **Lessons** L-265 (a library renews on every success), L-266 (a cap one source can fill is a lock), L-267 (a passing failure is not
  a verdict on the client), L-268 (one keying for every limiter), L-269 (a redaction pattern takes the whole shape), L-270 (copy that
  names a future release).
- **Decisions** D-76 (at a cap the cache gives way and the unused go first: built, owner pending), D-77 (which refusals end a device),
  D-78 (the plain hash of an address), D-79 (go for Phase 6). All in [pending decisions](../pending-decisions/phase-5.md).
- **Tasks** [P5-21](../tasks/phase-5-oauth/P5-21-recoverable-issuance-refusals.md) (keep the device when a refusal can pass),
  [P5-22](../tasks/phase-5-oauth/P5-22-keyed-address-hash.md) (key the counters with a secret).

## Go / no-go for Phase 6

**Go**, recommended (D-79). Phase 6 (tool breadth) depends only on Phase 2 and is independent of Phase 5. **Phase 7 (writes) is not
behind Phase 6**: the ROADMAP has it depending on Phases 2, 4 and 5, and its review (P7-09) needs this review (P5-10) merged to verify
the `mcp:write` scope; Phase 8 needs both 6 and 7. The owner steps are in the
[pending decisions](../pending-decisions/phase-5.md#owner-steps): the P6-14 client runs, disconnect and reconnect and a claude.ai
refresh, a real phone, and answers to D-68, D-69 and D-76 … D-78.
