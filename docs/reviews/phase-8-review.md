# Phase 8 review

- **Scope:** the Phase 8 power features (P8-01 … P8-11), range `eed67c4..ae19fbd`.
- **Method:** three read-only reviews (security, quality, performance); every finding is verified against the code before it is
  changed, and a fix starts with a test that fails without it (L-330). Verdicts: **fixed**, **deferred to <task>**,
  **not a defect** (with the reason).
- The runtime-side sections and the overall verdict are written by the runtime-side PR; this file holds both sides.

### CLI side

Branch `task/P8-12-review-fixes-cli`. Decisions D-287 … D-293, lessons L-443 … L-445, follow-ups P8-31 and P8-32.
P8-12 itself stays `todo` (it waits for the live pass).

**S-1 (medium) — Config bundle: addresses and credential-to-instance map not authenticated; the plan hid the URLs** — **fixed**
(verified: only `secrets` was sealed, the AAD was the fixed header; `credentials.create` validates the token against the instance URL,
so an edited `baseUrl` would receive it). The AAD now includes the canonical instance addresses and the credential-to-instance map
(file version 2, D-287); an edit fails with the same message as a wrong passphrase, before any request. The plan names each
address. Tests: seal/open with a binding, an edited file refused with nothing created, the plan shows addresses. Lesson L-443.

**S-2 (low) — `keychain:` reads any service; a project `.mcp.json` can redirect `AB_AGILITY_URL`** — **partly fixed, rest deferred to P8-31**.
Verified. An environment value (`AB_AGILITY_TOKEN`, `AB_MASTER_KEY*`) may now name only the `agility-bridge` service, so another
application's entries cannot be read; the user's own YAML file may still name any service (D-290). The redirect of the user's own
default entry to another host is not closed by that (the hostile file can use the default name): binding an entry to its
instance host is P8-31. The info remark about `keychain set` replacing an item with the same attributes is user-initiated: not a defect.

**S-6 (low) — doctor: chmod of a shared directory, control characters, FIFO** — **fixed** (all three verified; D-289). `--fix` repairs
the data directory only when `AB_DB_PATH` is not set (otherwise the command is printed); control characters are replaced in every
finding; client files are `lstat`ed first and opened with `O_NONBLOCK` (a FIFO is skipped). Tests for each. Lesson L-445.

**S-7 (low) — `client-config claude-code` unquoted** — **fixed**. Every interpolated value is single-quoted, `--keychain` is validated
with the reference parser. The test feeds `;`, `&`, `$()`, `|` and a quote through `--url` and checks that nothing outside quotes
is shell syntax.

**Q-3 (medium) — import cannot finish a partly failed run** — **fixed** (verified: the existing-workspace branch skipped every grant).
`config import --add-grants` (off by default, D-288) creates the file's service grants that an existing workspace lacks by label,
through the same admin checks; stderr prints the recovery steps when a run fails or leaves a workspace without its default credential.
Test: revoke the imported grant, a plain re-run skips it, `--add-grants` creates it once and a third run reports `exists`.

**Q-7 (low) — stdio silently ignores serve-only settings** — **fixed** (verified: no code under `apps/cli/src` reads them). A stderr
warning names the ones present when stdio starts configured (D-291); a shell with no Agility configuration (doctor, management
commands) is not warned.

**Q-8 (low) — `keychain status` "available" without a probe; `doctor --offline` reads the keychain** — **fixed** (D-292, L-444).
`available()` now needs exit status 0 (Linux: a lookup of a random attribute answering exit 1 with no message); `--offline` resolves no
keychain reference and reports the dependent checks as `skip`.

**Q-9 (low) — Windows script code page** — **fixed as far as it can be without a Windows machine** (D-293). The script pins UTF-8
(no BOM) for input and output, and `set` refuses a non-ASCII secret until a real run proves it (P8-32). Verified by reading the
script: the read-back shared the mangling, as the reviewer said; the test checks the script text and the refusal only (*unverified* on
Windows).
