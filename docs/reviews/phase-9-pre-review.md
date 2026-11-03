# Phase 9 internal pre-review (P9-02)

> 2026-11-03. A read-only security pass over the six areas of the [call for reviewers](../security/call-for-reviewers.md),
> done before the external review so reviewers do not spend their time on what we can find ourselves. Method: reading the
> code and its tests against the threat model rows, looking for what the existing tests do not already defend. Nothing was
> run against a real Agility tenant or client. The OAuth server and the admin API and panel were read by two independent
> passes (large files, read in chunks); the approval and write path, key handling, the access model and the query compiler by
> the author of this task. This is not a substitute for the external review.

## Result

No high or medium finding. One real defect fixed with a regression test, six low or informational points turned into tasks or
decisions, and a list of what was checked and found defended.

## Findings

| # | Area | Severity | Finding | Disposition |
|---|---|---|---|---|
| 1 | OAuth (T11, T20) | Low | Client-metadata-document eviction at the cap ran **before** the per-address and per-deployment fetch budgets, so an address with no budget left could still evict one cached document per request, costing real clients (claude.ai) a refetch. This contradicted the T11 statement that nothing is stored or consumed once the budget is spent. | **Fixed.** The room is made only after a document was fetched and validated, right before it is stored (`packages/http-app/src/oauth/server.ts`, `makeRoom`). Test `a refused fetch, or a document that fails validation, evicts no stored document` in `packages/http-app/test/oauth/clients-memory.test.ts` fails without the change. L-486. |
| 2 | OAuth (T9) | Low | The authorization code marker is taken before the provider checks the client id and the PKCE verifier, so someone holding a code can spend it with a wrong verifier, and the replay path then revokes the device. Denial of service only: PKCE still prevents theft. | Task [P9-11](../tasks/phase-9-hardening-launch/P9-11-oauth-pre-review-follow-ups.md). The test `suite.ts` pins today's behaviour as intended (RFC 6749 asks for revocation on code reuse); changing it is a design choice. |
| 3 | OAuth (T9, T15) | Low | The refresh claim lives 15 s without renewal and its `finally` deletes a claim that may belong to another request: a slow provider call can let two refreshes succeed without reuse detection. | P9-11. |
| 4 | OAuth (T15) | Info | RFC 7009 `revoke` skips the revocation tombstone that `revokeFamily` sets, so a refresh in flight can write the grant back (narrow window). | P9-11. |
| 5 | OAuth (T10) | Info | The look-alike filter for unverified client names covers Cyrillic and Greek mixing only: fullwidth or mathematical Latin, Cherokee and all-Cyrillic words pass. The name is shown as not verified with the redirect host prominent. | Task [P9-12](../tasks/phase-9-hardening-launch/P9-12-client-name-lookalikes.md). |
| 6 | Admin API (A14) | Low | Any member can read every instance, including `tls.caFile` (a server disk path), `baseUrl` and `metaFingerprint`, for instances without a grant of their own. | Task [P9-10](../tasks/phase-9-hardening-launch/P9-10-admin-api-pre-review-follow-ups.md). |
| 7 | Admin API (T14, A14) | Low | An admin can switch an instance or workspace back on after an owner switched it off (`PATCH ... disabledAt: null`). A change to this would contradict the documented admin role (and an existing test: admins add, rename, disable, enable and delete instances), so it was not changed. | Decision D-350 (recommended: keep and document); P9-10 holds the alternative. |
| 8 | Admin API (A5) | Info | `grants.create` has no personal-credential owner check, while `grants.update` has. By design (an owner must be able to give a write grant on a user's credential; the storage trigger forces the credential owner to equal the grant's user), but the threat-model wording says more than the code. | P9-10 (wording and a pinning test). |
| 9 | Admin sign-in (T14) | Info | Re-authentication on Google and GitHub carries no `auth_time`, so a "recent sign-in" there proves a recent IdP round trip, not a fresh credential; already accepted as D-34 and bound to the browser. | No change; stays in the call for reviewers as a known point. |

## Checked and found defended

- **Approval and write path.** The approval is bound to actor, tool, workspace and the exact change hash; a stored grant or
  round is read first and taken atomically just before the send, after the limiter, the re-read and the intent audit, so
  of two concurrent calls one sends and the other gets an error row. A refusal in between keeps the approval usable. The
  page reads pending records under the signed-in person's own id (another person's id, an unknown, a used and an expired
  id all find nothing), takes the record before anything else, checks the posted hash against the stored one and caps open
  requests per person. Writes fail closed when the intent audit cannot be stored. No path lets confirm, a decline or a
  client answer stand in for approval (`packages/core/src/writes/`, `packages/http-app/src/approval-page.ts`).
- **Query compiler and scope.** Every value is a bound variable, identifiers come from instance metadata, the scope predicate is
  added at the top level, and a workspace or grant with no project is refused (`no_projects`, creation and policy parsing both
  require at least one), on the pass-through path too through the stored policy. Property tests and the P9-01 fuzz cover
  cursors and field paths.
- **Access model.** One resolver, deny by default, audience first; property-tested never to exceed an input; negative
  authorization matrix over routes, principals and tools on Node and workerd.
- **Key handling.** AES-256-GCM with the record context as additional data, versioned purpose keys, constant-time
  comparisons for tokens, checksums and the admin token, hash-only storage of device tokens and session secrets, secrets never
  in arguments, redaction at every log and audit boundary (fuzzed in P9-01).
- **OAuth.** Exact redirect-URI matching, S256 for every client, audience (RFC 8707) per workspace, single-use consent
  handles with CSRF and fetch-metadata checks, strict CSP and `frame-ancestors 'none'`, CIMD fetches without redirects, 5 KiB,
  5 s and a public-address check at connect time; no request data in module state.
- **Admin API and panel.** Every writer goes through the guarded services; bodies are strict schemas (no mass assignment);
  cookie sessions need fetch metadata, an exact `Origin`, the CSRF header and a JSON content type; a request with an
  `Authorization` header never falls back to a cookie; list and get routes strip ciphertext and hashes; members see only their
  own grants, credentials, tokens, sessions and audit rows; CSV cells are quoted and formula-neutralised; every state-changing
  route writes an audit row.

## Not covered

The Worker runtime configuration and the release pipeline were not re-read in this pass (the P3 and P0 reviews cover them);
nothing was tested against a live tenant or a real MCP client (L-1 to L-10 in the [evidence map](../security/threat-evidence.md)).
