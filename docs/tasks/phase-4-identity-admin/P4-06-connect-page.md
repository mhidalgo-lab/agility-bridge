---
id: P4-06
title: Connect page with client snippets
phase: 4
status: done
priority: medium
depends_on: [P4-04, P4-07]
adr: ["0016"]
lessons: [L-023, L-026, L-085, L-121, L-133]
owner: "claude-agent"
---

# P4-06 — Connect page with client snippets

## Goal
A person who holds a grant picks their client and copies a working configuration for that workspace: the endpoint, the
header, and where the device token goes. The token itself appears in a snippet only on the one-time page that issues it.

## Scope

**Snippet module** (`packages/admin-ui/src/snippets.ts`, pure text, web-standard)
- Typed input: the public endpoint (built from the configured `AB_PUBLIC_URL`, never from `Host`), the workspace slug and an
  `auth` value. Today `auth` is `{ kind: 'device-token', token? }`; Phase 5 adds `{ kind: 'oauth' }` as a new case with
  its own per-client builders, without touching the page or the existing snippets. One builder per client, one registry.
- Clients (the primary matrix of `client-compatibility.md`, remote use): GitHub Copilot in VS Code, GitHub Copilot in
  JetBrains, GitHub Copilot CLI, Claude Code (command and `.mcp.json`), Cursor, Windsurf / Devin Desktop and MCP Inspector
  CLI. claude.ai, Claude Desktop (connectors) and Claude mobile are listed as "needs OAuth (Phase 5)": a static header
  cannot be entered there reliably and the task adds no third-party bridge (D-41).
- Secrets: a snippet never puts a token in a shell command (history) or a file the client reads itself where the client
  can prompt (VS Code `inputs`, `password: true`) or expand a variable (`${AGILITY_BRIDGE_TOKEN}`, `${env:…}`); only
  JetBrains (no expansion, no prompt) takes the literal token, and only when the page was rendered right after issuing it.
- Quoting per format: JSON through `JSON.stringify`, POSIX shell words single-quoted, PowerShell single-quoted. The slug is
  also checked against the storage rule (`[a-z0-9-]`, 1-63) so `${…}` interpolation inside a client config cannot be
  smuggled in. No client in the matrix is configured through TOML, so there is no TOML snippet.
- Each client's current documented format, verified against the vendor documentation; facts with date and source go to
  `docs/RESEARCH.md`, unverified ones are marked.

**Panel** (rendered by the existing token routes, same role/ownership rules as P4-04/P4-07)
- `GET /admin/me/grants/:id/connect` (member and up, **own grants only**, forged ids and someone else's grant give the 404
  page for every role) and `GET /admin/grants/:id/connect` (owner and admin, any grant).
- Content: endpoint URL, a client list (copy buttons only through the existing same-origin script; plain selectable `<pre>`
  otherwise), placeholders everywhere, a link to issue a device token (shown only when the grant can issue one), warnings
  for a disabled workspace or a revoked / expired grant.
- The one-time token page (the POST's answer, `no-store`) shows the same snippets with the token where a literal is
  unavoidable. Reloading it shows nothing (single-use handle, P4-04). Nothing stores, redirects or logs the token.
- Links from "My access", "My grant" and the admin grant page; the endpoint is shown in full on the one-time page.
- `AdminUiDeps.publicOrigin` carries `AB_PUBLIC_URL`'s origin into the panel.

**Docs**: `docs/guide/clients.md` gains the remote section with the same snippets (a test compares them with the generated
ones, L-133); `client-compatibility.md` setup notes agree; `docs/guide/admin-panel.md` and `docs/dev/admin-ui.md` describe
the page.

## Acceptance criteria
- [x] Every primary client has a snippet in its currently documented format; formats and sources are recorded in
  `docs/RESEARCH.md` with date, unverified ones marked.
- [x] Endpoint comes from `AB_PUBLIC_URL`; a hostile `Host`/`X-Forwarded-Host` changes nothing.
- [x] Role and ownership matrix: member own grant ok; member/owner/admin on someone else's grant through the member area
  404; admin area refuses members; signed-out redirects; revoked / expired / disabled shown honestly; no upstream call.
- [x] The Connect page (GET) never contains a token; the token appears only in the POST answer, only in the JetBrains
  snippet and the token box; the reload answer, redirects, flash and URLs never contain it (tests scan).
- [x] Hostile slug, label, endpoint and token strings cannot break out of JSON, shell or PowerShell quoting (tests, with a
  real shell round trip where one exists) and are HTML-escaped.
- [x] The guide's remote snippets equal the generated ones (test).
- [x] A workerd smoke renders the Connect page.
- [x] Key security tests are mutation-checked (L-121), recorded under Outcome.
- [x] `docs/guide/clients.md`, `docs/guide/admin-panel.md`, `docs/dev/admin-ui.md`, `docs/reference/client-compatibility.md`,
  `docs/RESEARCH.md` updated; changeset added.

## Security notes
THREAT_MODEL T8 (device tokens), T13 (admin XSS), A5. The page shows no secret; the only literal token is on the `no-store`
one-time page.

## Lessons applied
- L-023 — SDK conformance does not prove client compatibility: formats come from vendor docs and are marked verified or not.
- L-026 — Configure stdio servers through the client, never through flags: remote snippets keep the token in the client's
  secret mechanism or an environment variable, never as a command-line value.
- L-085 — One-time secrets never travel in URLs.
- L-121 — Negative authorization is first-class.
- L-133 — Documented commands and snippets are tested.

## Docs to update
- docs/guide/clients.md, docs/guide/admin-panel.md, docs/dev/admin-ui.md, docs/reference/client-compatibility.md, docs/RESEARCH.md

## Notes from relic-bridge (same owner)
- Its connect page was an admin-only project picker with snippets; here the page hangs off a grant (the person who holds it,
  or an admin helping), because the endpoint and the token belong to a grant.
- Shell snippets read the token from an environment variable (`read -rs`), the Claude Desktop `mcp-remote` bridge is not
  ported (third-party package, OAuth connector instead; D-41), and `data-copy` buttons stay progressive enhancement.

## Out of scope
- OAuth snippets and the claude.ai / Desktop / mobile connector walk-through (Phase 5).
- Codex, Zed, Cline, Gemini CLI and other secondary clients (add a builder when verified).
- Running every snippet in the real client: the owner's matrix runs do that (formats are checked against documentation).

## Outcome

- **Built**: `packages/admin-ui/src/snippets.ts` (typed `SnippetInput` with `auth: SnippetAuth`, one builder per client in
  `CLIENT_BUILDERS`, `shellWord` / `powershellWord`, `endpointFor`, `OAUTH_ONLY_CLIENTS`), `screens/connect.tsx` (`SnippetList`,
  `ConnectPage`), the routes `GET /admin/me/grants/:id/connect` and `GET /admin/grants/:id/connect` inside the shared token routes
  (`tokens.tsx`, so both areas reuse `loadGrant`, `canIssueOn`), the snippets on the one-time token page, links from My grant and
  the admin grant page, `AdminUiDeps.publicOrigin`, snippet styles (assets regenerated).
- **Clients and formats** (vendor documentation read 2026-10-23, facts and sources in `docs/RESEARCH.md`; none run by this task):
  VS Code (`inputs` password prompt, `servers.<name>`), JetBrains (`requestInit.headers`, the only literal token), Copilot CLI
  (`copilot mcp add --transport http --header`), Claude Code (command, PowerShell 7, `.mcp.json` with `${VAR}`), Cursor
  (`${env:VAR}`), Windsurf / Devin Desktop (`serverUrl`, `${env:VAR}`), MCP Inspector CLI (flags as run in the P0-07 spike).
  Unverified: Copilot CLI header variable substitution (not used), `Read-Host -MaskInput` availability (PowerShell 7.1+).
- **Tests**: `packages/admin-ui/test/snippets.test.ts` (slug rule, documented shapes, token holders, hostile strings through JSON
  parse-back, a real bash round trip with stub commands and PowerShell quoting, pwsh round trip when installed (skipped here),
  guide equals generated), `packages/admin-ui/test/connect-screens.test.tsx` (fake API: origin from configuration, hostile name
  and slug, member area, HEAD), `packages/http-app/test/connect-page.test.ts` (real sessions and storage: role and ownership
  matrix, revoked and disabled, `Host` / `X-Forwarded-*`, the one-time page, replay, scans of redirects, flash, logs and audit
  rows) and a workerd smoke in `apps/worker/test/worker.test.ts` (Connect page on the Worker).
- **Mutation checks (L-121)**: 9 deliberate reversions, each fails at least one test: shell quoting removed, slug rule removed
  (generator and predicate), VS Code snippet with the literal token, member-area ownership check removed, issue link always shown,
  one-time page without the token in JetBrains, Connect page passing a token, configured origin replaced.
- **relic-bridge findings folded in**: its P4-06 port (project picker became a grant page; `read -rs` for shell snippets; no
  literal token outside the one-time page; `data-copy` progressive enhancement; endpoint only from the public origin), its review
  note that `docs/dev/admin-ui.md` omitted the snippet files (covered), and the decision not to port the `mcp-remote` Claude Desktop
  snippet (D-41).
- **Not done / notes**: no TOML snippet (no client of the matrix uses one); no Codex/Zed/Cline/Gemini snippets (out of scope);
  claude.ai / Desktop / mobile wait for OAuth (Phase 5); formats are from documentation, the owner's matrix runs verify them.
- **New**: lessons L-210 to L-214, decisions D-41 and D-42, changeset.
