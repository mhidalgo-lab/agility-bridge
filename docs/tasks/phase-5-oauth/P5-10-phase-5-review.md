---
id: P5-10
title: Phase 5 review
phase: 5
status: review
priority: high
depends_on: [P5-07, P5-08, P5-09]
adr: []
lessons: [L-004, L-013, L-023, L-096, L-117]
owner: ""
---

# P5-10 — Phase 5 review

> Refined 2026-10-27 (tasks/README rule 7).

## Goal
Close Phase 5 with evidence: an independent adversarial read of the OAuth surface, a re-check of the client matrix, a
read-only live pass against the real deployment, and a go or no-go for Phase 6.

## Scope
- An independent security review of the OAuth surface (`packages/http-app/src/oauth/*`, the CLI and Worker hosts, the
  admin pages of P5-08): authorization (PKCE, resource and audience binding, redirect URI matching, `iss`, open
  redirects, `prompt=none`, consent CSRF and clickjacking, the single-use handle); the token endpoint (code reuse, the
  refresh family and its reuse window, D-70 sealing, revocation on every path, disconnect and cache TTL); registration
  (DCR field filtering, the CIMD SSRF guard on Node and Workers, cache poisoning, caps); abuse controls (fail-open,
  counter keys, IP extraction behind Cloudflare and proxies); storage (hash-only tokens, no plaintext in rows, logs or
  audit, expiry and sweeps); cross-workspace and cross-user isolation and admin revoke authorization; the
  web-standard-only rule and per-request state (L-013, L-096); redaction of every new secret shape (L-117); docs against
  code. Every claim is reproduced with a throwaway test against local fakes; only reproduced issues are findings, fixed
  with mutation-checked regression tests or recorded as follow-up tasks or decisions, ranked by severity.
- Matrix re-check: the client matrix and the P5-06 / P6-14 split agree with the guides; nothing is called verified
  without evidence.
- Live pass against the real deployment, limited to unauthenticated, read-only HTTP checks (health, the two discovery
  documents, the `401` challenge, a wrong `Host`, `/oauth/authorize` with a bad client, a GET of `/oauth/token`). No
  registration, no completed authorization, no tool call, no admin token. The hostname is never written into the repo.
- `docs/reviews/phase-5-review.md`, the go for Phase 6 recorded as a decision (Phase 7, writes, depends on Phase 6),
  P5-07 set to `done` (PR #115 is merged).

## Acceptance criteria
- [x] `docs/reviews/phase-5-review.md`; every finding fixed or recorded, with tests.
- [x] Matrix re-check recorded; no unverified claim of "verified".
- [x] Live results recorded without the hostname; owner steps listed (P6-14 client runs, disconnect and reconnect).
- [x] Go for Phase 6 recorded as a decision with options and a recommendation.
- [x] Every Phase 5 task is `done` or an open follow-up; no unticked box left in a done task; lesson and decision
      numbering consistent.

## Outcome
- [docs/reviews/phase-5-review.md](../../reviews/phase-5-review.md): four medium findings (M1 a revocation request renewed unused
  registrations for 90 days; M2 one source could hold the registration caps; M3 a passing document-fetch failure answered
  `invalid_client` at the token endpoint; M4 OAuth limits keyed per IPv6 address), two low (redaction of `Bearer` tokens, stale
  Connect page copy), all fixed with mutation-checked tests; recorded: D-77 (refusals that pass end the device), D-78 (plain address hash).
- Live pass: unauthenticated and read-only, matched the design. Go for Phase 6 recorded as D-79 (owner pending).
- New: lessons L-265 to L-270, decisions D-76 to D-79, tasks P5-21 and P5-22. P5-07 set to done; Phase 5 lessons moved into their theme.

## Security notes
None beyond the shared rules in AGENTS.md. Security-relevant fixes update THREAT_MODEL in the same PR.

## Lessons applied
- L-004 — End every phase with a review and a live pass, and reserve capacity for follow-ups.
- L-013, L-096 — No module-level request state; never share in-flight I/O between requests.
- L-023 — SDK conformance does not prove client compatibility.
- L-117 — Redact in one place, for every new secret shape.

## Docs to update
- docs/reviews/phase-5-review.md (new)
- docs/pending-decisions/phase-5.md (go for Phase 6)
- docs/LESSONS-LEARNED.md, docs/THREAT_MODEL.md (as findings require)

## Out of scope
- Re-doing the per-task reviews done inside P5-01 … P5-09.
- Anything not listed under Scope.
