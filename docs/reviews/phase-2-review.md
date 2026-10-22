# Phase 2 review

- **Scope:** all Phase 2 code (P2-01 … P2-16): `packages/storage` and `packages/storage-sqlite` (schema, migrations,
  triggers, adapters, files, backups), `packages/auth` (secrets, access model, resolver, guards, device and admin
  tokens, validation, pass-through), `packages/http-app` (edge, MCP over HTTP, rate limits, audit, admin API),
  `apps/cli` (`serve`, management commands, master key), the Docker image and the self-hosting guides.
- **Date:** 2026-10-21. **Branch:** `task/P2-17-phase-2-review`, on top of `main` after #60.
- **Method:** two adversarial reads by separate reviewers with fresh contexts, each reproducing every claim with a
  throwaway test in an isolated worktree and changing nothing: one over the whole phase, one over the pass-through mode
  (P2-14, merged while the first ran). Every finding below has a regression test, and each security fix was
  mutation-checked: the test fails with the fix reverted (L-121). Live: the read-only suite against the third-party
  tenant, plus a new server check (`live/server.live.test.ts`) that runs the Phase 2 path in-process through the guarded
  fetch; MCP Inspector CLI against `agility-bridge serve` with a device token (synthetic upstream).
- **Checks:** `pnpm lint && pnpm typecheck && pnpm test` green (1,056 tests); `pnpm test:live` green (11 tests, about
  15 read requests for the server check; counts and statuses only were recorded).

## Verdict

**Ready for v0.2 with the fixes in this branch.** One high finding (plain-HTTP requests could pass the pass-through
HTTPS check) and four medium ones are fixed with regression tests. One gap moves to a follow-up task (P2-19, plain-HTTP
instance URLs in `serve`), one is accepted (a timing difference on pass-through workspaces). Open items need the owner:
real-client runs over HTTP, the new required check for the Docker job, the image-publishing decision (D-25) and the go
for Phase 3 ([pending decisions](../pending-decisions/phase-2.md)).

## Per-task completeness

| Task | PR | Status | Evidence / gap |
|---|---|---|---|
| P2-01 storage schema | #44 | met | STRICT tables, cross-row triggers, memory/SQL contract suite (the reviewer's 45-input differential run agreed); review M1 and L2 add triggers here |
| P2-02 SQLite adapter | #45 | met | `O_EXCL`/`O_NOFOLLOW`, inode re-check, modes, backup and restore never overwrite; frozen 0.2 fixture |
| P2-03 secrets | #46 | met | AES-256-GCM with AAD, HKDF purposes, key-check values, CAS rotation (contention fix during the task), retirement |
| P2-04 access model | #47 | met | resolver property tests, guards; review M2 tightens personal credentials |
| P2-05 device tokens | #48 | met | format and CRC before lookup, hash at rest, constant-time compare, workspace binding |
| P2-06 HTTP app | #49 | met | both eras, uniform 401, body caps, batch refusal, Host/Origin; review L3 tightens `Host`, F1 the request target |
| P2-07 rate limits | #51 | met | per address, failures, token, grant; review L4 adds IPv6 /64 keys, F2 a validation budget |
| P2-08 audit | #52 | met | tool calls, refusals (capped), admin changes, retention, secret scans of rows |
| P2-09 admin API | #53 | met | owner/admin guards, break-glass token, OpenAPI reference; review L1 for its token file |
| P2-10 CLI management | #55 | met | local and remote, `init`, `keys`, generated reference |
| P2-11 Docker image | #57 | met, owner step | built, smoke-tested and scanned in CI; the new check is not yet required; publishing is D-25 / P2-18 |
| P2-12 authz suite | #54 | met | route × principal × tool matrix, zero upstream calls on denial, hostile upstream; found L-174 |
| P2-13 credential validation | #56 | met | origin probe without a token, validation, revalidation after refusals; live checked here |
| P2-14 pass-through | #60 | met | read-only, HMAC fingerprint; review F1, F2, F4 fixed here; live checked here |
| P2-15 inventories | #58 | met | cryptography, logging, data protection, with a coverage test |
| P2-16 self-hosting docs | #59 | met | walkthrough executed in CI from the packed tarball |

## Findings

Status: **fixed** (this branch, regression test, mutation-checked), **task** (new task file), **accepted** (residual
risk, recorded in the [threat model](../THREAT_MODEL.md#8-residual-risks-and-accepted-trade-offs)).

### High

**F1 — Absolute-form request targets passed the pass-through HTTPS check over plain HTTP** — **fixed.** `serve`
decided "HTTPS" from `new URL(c.req.url).protocol`, and `@hono/node-server` builds that URL from an absolute-form
target, so `POST https://host/w/x/mcp HTTP/1.1` on a plain socket was accepted with a caller's Agility token in clear
text (reproduced: 200 and one upstream validation). Now the server, which never terminates TLS itself, trusts only a
trusted proxy's `X-Forwarded-Proto: https`, and `originFormOnly` answers 400 to any target that is not `/path`
(`absolute-form`, `*`, `//host`). Raw-socket tests in `apps/cli/test/serve.test.ts`. Lesson L-175.

### Medium

**M1 — The last-owner rule could be defeated by concurrent requests** — **fixed.** The guard counted owners, then
wrote; two owners demoting each other at once left none. Storage triggers (`users_last_owner_update`,
`users_last_owner_delete`) and the same rule in the memory adapter now refuse it for every writer. Contract tests in
`packages/storage/test/contract.ts`. Lesson L-177.

**M2 — An admin could mint a device token that acts as a member's personal Agility token** — **fixed.** Creating a
grant for Alice on Alice's personal credential and issuing a token on it gave the admin a bearer that called Agility as
Alice. Now only the credential's own user can put a grant on it or issue device tokens for such a grant, and switching
a grant to a personal credential revokes its existing tokens (`guards.ts` `needCredentialOwner`, `services.ts`).
Tests in `packages/http-app/test/admin.test.ts` and `packages/auth/test/services.test.ts`.

**F2 — Invalid pass-through tokens each cost an upstream validation, even after the failure limit** — **fixed.** The
failure budget was read only after validating, so an exhausted address kept spending the instance's Agility quota. Now
an exhausted address gets 429 before any upstream call, new-token validations are capped per instance
(`AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE`, 30), and concurrent requests with the same new token share one validation.
Tests in `packages/http-app/test/passthrough.test.ts`. Lesson L-176.

### Low

- **L1 — the admin-token-file check followed no symbolic links** — **fixed:** it uses the master key's realpath-based
  `isInside`, so a link into the data directory is refused (test skipped on Windows). CI on macOS then showed that `isInside` did not resolve links for a file that does not exist yet (`/var` → `/private/var`), so a missing file in a linked data directory passed the check; it now resolves the deepest existing ancestor.
- **L2 — "retarget while revoked, then un-revoke" was possible in storage** (no route exposed it) — **fixed:**
  revocation is final for credentials, grants and tokens (trigger and memory adapter).
- **L3 — the `Host` allowlist accepted malformed values** (`localhost:8787, evil`, `localhost:evil`, `[::1]junk`) —
  **fixed:** strict `name|[v6]` plus an optional numeric port; anything else is 403.
- **L4 — IPv6 clients could rotate addresses past the per-address limits** — **fixed:** IPv6 is counted per /64,
  IPv4-mapped addresses as IPv4 (`addressKey`).
- **F4 — the pass-through identity cache was cleared wholesale at 10,000 entries** — **fixed:** expired entries go
  first, then the oldest.
- **Task P2-19 — plain-HTTP instance URLs are accepted by `serve`.** `canonicalInstanceUrl` allows `http://localhost`
  and `http://127.0.0.1` in every mode (meant for tests), contrary to A9 and ADR-0014; private addresses are allowed
  on purpose (on-premises instances). P2-19 adds `AB_ALLOW_HTTP_INSTANCES` (off) and an opt-in private-address refusal.
- **Accepted — F3, timing difference on pass-through workspaces:** a bad token answers after an Agility round trip on
  a pass-through workspace and at once elsewhere, so a caller can tell which slugs are pass-through. Status and body are
  identical; padding every 401 was judged not worth the latency.

## Checked and sound

Device tokens: format and CRC before any storage read, SHA-256 at rest, constant-time compare, audience first; wrong,
unknown and bad requests got identical 401 bodies and headers. The access cache is keyed by token hash and slug, never
outlives expiry and is bounded. Chunked bodies over the cap get 413; batches are refused; security headers are on
every status. The resolver's intersections hold and shared credentials never get write tools. AES-GCM with `id|version`
AAD and fresh IVs, per-purpose HKDF keys, boot refusal of a reused version, CAS rotation; errors carry no key material.
Memory and SQLite agree on cross-row triggers, foreign-key rules, constraints and counters. Files are opened with
`O_EXCL`/`O_NOFOLLOW` and re-checked by inode; backups never overwrite. Secrets reach the CLI only by file, environment,
stdin or hidden prompt. Pass-through: the identity cache holds a keyed fingerprint, never the token; `X-Forwarded-Proto`
is honoured only with trusted hops and matched exactly; a Bearer header takes precedence; stored-credential workspaces
refuse the header with the same 401; no write tools; the token never reaches a logger.

## Live verification

- `pnpm test:live` (read-only guard, shapes and counts only): 11 tests green, including the new server check: the
  origin probe and validation against the tenant, a workspace with a device token over Streamable HTTP in the 2025 era
  and 2026-07-28 (`tools/list`, `whoami`, `search_work_items`), a pass-through `whoami`, five audit rows with status
  `ok`, and neither token in logs or audit.
- MCP Inspector CLI 2.11.0 against `agility-bridge serve` with a device token (synthetic upstream): `tools/list`, a
  tool call, 401 without the token ([client matrix](../reference/client-compatibility.md)).
- Owner's runs: VS Code, JetBrains, Copilot CLI, Claude Code and Cursor over HTTP against `serve` with device tokens
  (the P0-07 runs covered the same transports against the spike).

## Go / no-go for Phase 3

**Go**, recommended: storage, secrets, access model and HTTP are reviewed and fixed, and P2-19 does not block the edge
work (Workers apply their own egress rules). Recorded in [pending decisions](../pending-decisions/phase-2.md) (D-26).
