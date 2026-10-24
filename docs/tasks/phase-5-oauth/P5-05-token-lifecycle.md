---
id: P5-05
title: Token lifecycle and refresh concurrency
phase: 5
status: review
priority: high
depends_on: [P5-01]
adr: ["0009"]
lessons: [L-029, L-074, L-094, L-164, L-247]
owner: "claude-agent"
---

# P5-05 — Token lifecycle and refresh concurrency

## Goal
Tokens rotate safely even when clients refresh in parallel: a client that refreshes five times at once keeps its
device, a stolen and replayed refresh token costs the thief the device, and a disconnected device cannot refresh.

## Scope
- **Lifetimes.** Access 1 h and refresh 30 d are already configurable with bounds (`AB_OAUTH_ACCESS_TTL` 60 s-24 h,
  `AB_OAUTH_REFRESH_TTL` 1 h-365 d, P5-01); this task keeps them and adds `AB_OAUTH_REFRESH_REUSE_WINDOW` (default 30 s,
  0-120 s; `0` = strict single use; not longer than the access lifetime). Every refresh rotates the refresh token.
- **Refresh family (D-63, D-70).** `workers-oauth-provider` 1.2.3 keeps only the last refresh token after parallel
  refreshes (L-164) and accepts the previous one once more without a time limit. Our token endpoint wraps the `refresh_token`
  grant with a per-grant refresh family in `kv`:
  - an atomic claim per refresh token (`kv.setIfAbsent`) lets exactly one request reach the provider; concurrent
    requests with the same token wait for its result and are answered with the **same successor** (refresh and access
    token);
  - a rotation marker (hash of the spent token, no secret) lives for the refresh lifetime; the successor's response is
    kept **encrypted** (AES-GCM, key derived from the spent refresh token itself, so only a holder of it can read it)
    for the reuse window only;
  - a repeat inside the window gets the stored successor; a repeat **outside** the window (or with a window of 0)
    revokes the whole device (tombstone, grant, every access and refresh token), writes `oauth.refresh.reuse` without
    token material and answers `invalid_grant`.
- **Revocation on every refresh.** Tombstone and grant existence are checked on every refresh, on the replay path too
  (the provider's own path already re-runs the access decision through the issuance check). A device disconnected in My
  access (P5-04), replaced or pushed out by the device cap (D-67) cannot refresh. A refresh that raced with a revocation
  revokes again and returns nothing.
- **Client binding on replay.** The replay path never reaches the provider's grant handler, so the client is
  authenticated through the provider (a probe with an unusable refresh token) and must be the grant's client.
- Both hosts: Node `serve` (SQLite) and the Worker (D1); no `node:*` in `packages/http-app`.

## Acceptance criteria
- [x] Parallel-refresh test (several concurrent refreshes from one client) keeps the device, all get the same working
  successor and the successor refreshes again; replay after the window revokes the device and every token of it.
- [x] The reuse window's successor tokens are kept encrypted, never in plaintext; a storage scan (kv rows, audit,
  logs, SQLite file) finds no refresh or access token, and the successor row is gone after the window.
- [x] `AB_OAUTH_REFRESH_REUSE_WINDOW` (0-120 s, not above the access lifetime) is read by both hosts with bounds tests;
  the lifetimes keep their bounds tests.
- [x] Negative tests: a disconnected or replaced device cannot refresh (also inside the window); a wrong client, a wrong
  secret or another `resource` gets no successor; a forged token of a real device revokes nothing; window `0` is strict.
- [x] The suite runs on memory, SQLite and workerd/D1.
- [x] Security tests are mutation-checked (L-121), recorded under Outcome.
- [x] `docs/guide/oauth-how-it-works.md` (new), `docs/dev/oauth.md`, configuration docs, THREAT_MODEL T9 and T15,
  decisions (D-63 superseded, D-70), lessons and a changeset are done.

## Outcome
- Built as scoped. The refresh family wraps the token endpoint's `refresh_token` grant (`oauth/server.ts` `refreshGrant`,
  seal and client-id reader in `oauth/refresh-family.ts`); `AB_OAUTH_REFRESH_REUSE_WINDOW` is new (`refreshReuseWindowSeconds`),
  the lifetimes already had their bounds. Decisions: D-63 superseded, D-70 new (the successor is sealed under a key derived
  from the spent token, not under a master-key purpose: the owner may prefer (b), see the decision). The device cap and
  replace-after-exchange (D-67) were already built in P5-04; here they show as "cannot refresh" tests.
- Beyond the brief: the repeat path authenticates the client through a provider probe and re-runs the access decision on
  the grant's props (L-254); a refresh that finds a tombstone revokes again before and after the provider rotates.
- Tests: `defineRefreshFamilySuite` (16 cases) on memory, memory in the Workers shape, SQLite and workerd/D1, each with
  window 30 and window 0 where it matters (time moves only on memory); unit tests of the seal, the client-id reader and the
  settings bounds; a My access disconnect case in `consent.test.ts`; the settings tests of both hosts.
- Mutation checks (L-121), each reverted: claim always won (4 failing cases), reuse does not revoke (8), window never
  ends by age (survives: the sealed row's own expiry enforces the same, equivalent), successor stored in clear (17), no
  tombstone check before rotating (survives alone: the check after rotating catches it; both removed: 2 fail), no
  re-read after the claim (survives: needs a request interleaved between a read and a claim, reasoned and documented,
  L-253), no grant check on the repeat path (4), no client probe (6), no client id binding (2), no resource check (2), no scope
  check (2), no access decision on the repeat path (2), marker written before the sealed answer (2), window of a day (12),
  no `oauth.refresh.reuse` row (8), claim not released on failure (2, an existing retarget test).

## Security notes
THREAT_MODEL T9, T15 (T21, T23 touched: no module-level request state, no secret in logs).

## Lessons applied
- L-029 — Clients refresh OAuth tokens concurrently.
- L-073 — One-time state is consumed atomically (the claim and the markers).
- L-074 — The master key never lives next to the data (no new key: the successor key derives from the spent token).
- L-094 — Follow the OAuth details clients rely on.
- L-121 — Negative authorization is first-class.
- L-164 — The OAuth provider keeps one refresh token per grant.
- L-247 — Read what a library helper does besides what you call it for (the previous-token rule).

## Docs to update
- docs/guide/oauth-how-it-works.md (new), docs/dev/oauth.md, docs/guide/configuration.md, docs/ARCHITECTURE.md
- docs/THREAT_MODEL.md, docs/pending-decisions/phase-5.md, docs/LESSONS-LEARNED.md

## Out of scope
- Idle expiry and last-used time of a device (P5-14); administrator views of devices (P5-08); per-surface rate limits
  on the token endpoint (P5-09).
- A master-key purpose for the successor (D-70 explains why none is needed).
