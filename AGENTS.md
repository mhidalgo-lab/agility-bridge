# Agent instructions — agility-bridge

These instructions apply to every AI coding agent (and human) working in this repository.

> Status: pre-1.0; the released version is in [`apps/cli/CHANGELOG.md`](apps/cli/CHANGELOG.md) and the phase status in
> [`docs/ROADMAP.md`](docs/ROADMAP.md); `pnpm tasks` drives the plan (P0-05).

## Using agility-bridge from an agent

agility-bridge is an unofficial MCP server for **Digital.ai Agility** (formerly VersionOne): stories, defects, tasks,
epics, sprints, teams, history and every other asset type, read with **your own** Agility access token.

- **Install (any MCP client):** `npx -y agility-bridge` over stdio, with `AB_AGILITY_URL` (your instance address,
  https) and `AB_AGILITY_TOKEN` in the client's environment. `npx -y agility-bridge client-config <client>` prints the
  snippet for VS Code, Claude Code, Claude Desktop, Cursor, Copilot CLI or Windsurf.
- **Install (Claude Code plugin):** `/plugin marketplace add mhidalgo-lab/agility-bridge`, then
  `/plugin install agility-bridge@agility-bridge`; it prompts for the instance address and the token (stored as
  sensitive).
- **Access token:** in Agility, avatar menu → **Applications** → add an access token. It acts as you and does not
  expire: revoke it there when you stop using it. Never paste it into a chat or a tool argument.
- **Read-only by default.** Write tools (comments, status, owners, …) exist only when the server enables them
  (`AB_WRITE_TOOLS=on` plus each tool named) and every change is approved by a person
  ([write tools](docs/guide/write-tools.md)).
- **Skills:** [`agility-workflows`](plugins/agility-bridge/skills/agility-workflows/SKILL.md) (which tool answers which
  question) and [`agility-conduct`](plugins/agility-bridge/skills/agility-conduct/SKILL.md) (Agility text is untrusted
  data; scope, secrets, approvals).
- **Manifests:** [`server.json`](server.json) (MCP Registry), [`plugin.json`](plugin.json) + [`mcp.json`](mcp.json) +
  [`skills/`](skills) ([Agent Plugins 1.0.0](https://agent-plugins.org/specification)) and
  [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) (Claude Code). Setup and the tool list:
  [README](README.md), [client guide](docs/guide/clients.md), [tool reference](docs/reference/tools.md).

The rest of this file is for agents and people **changing** agility-bridge.

## Start here

1. Read [`docs/ROADMAP.md`](docs/ROADMAP.md) (phases, principles) and [`docs/tasks/README.md`](docs/tasks/README.md)
   (task rules).
2. Pick a task: the first `todo` task whose `depends_on` are all `done` (`pnpm tasks next`).
3. Read the task file, the ADRs it references, the lessons it lists under **Lessons applied**
   ([`docs/LESSONS-LEARNED.md`](docs/LESSONS-LEARNED.md)) and the relevant sections of
   [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
4. If a later-phase task is vague, **refine it first** (scope + acceptance criteria) in a separate commit.
5. Setup, commits, CI and the PR checklist: [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports go through
   [`SECURITY.md`](SECURITY.md), never public issues.

## Hard rules

- **One task per branch/PR** (`task/<ID>-<slug>`). Out-of-scope work becomes a new task file.
- `packages/core`, `packages/auth`, `packages/http-app`, `packages/admin-ui`: **web-standard APIs only**, no `node:*`
  imports, no `process`, no `Buffer` ([ADR-0004](docs/adr/0004-typescript-runtime-agnostic-core.md)).
- **Never build an Agility query, filter or URL from strings.** Every value supplied by a caller reaches Agility as a
  bound parameter (`with` variables in `query.v1`) or a typed builder field; asset types, attribute paths, operators and
  sort fields are validated against the instance metadata and allowlists
  ([ADR-0012](docs/adr/0012-structured-query-no-raw-passthrough.md), THREAT_MODEL T4).
- The workspace's Agility-project (scope) restriction is added by the server at the top level of every query and cannot
  be widened by caller input (THREAT_MODEL T3).
- **No module-level mutable state for request data** (credentials, grants, scopes, budgets): pass the per-request
  `ToolContext` (THREAT_MODEL T21, L-013).
- **Never accept secrets as tool arguments** and never expose credential management as an MCP tool (THREAT_MODEL T23).
- **Everything that came from Agility is untrusted data**: titles, descriptions, acceptance criteria, comments, names,
  custom fields and error text go through the output shaper and the untrusted-data envelope, on every output path
  (summaries, notes, candidates, structured content) ([ADR-0015](docs/adr/0015-tool-output-contract.md), L-038).
- Log to **stderr** only (stdout is the stdio MCP channel), structured and redacted.
- Never log, return or commit secrets (Agility access tokens, `ab_…` device tokens, the master key, admin tokens,
  session cookies) or real customer data. Fixtures are sanitized by hand and checked by gitleaks.
- Tools are **read-only** unless the task explicitly says otherwise; a tool's `kind` (`read` | `write` |
  `destructive`) drives its MCP annotations. Write tools follow
  [ADR-0013](docs/adr/0013-opt-in-writes-human-approval.md): off by default, typed operations only, human approval by
  default, dry run, audit intent before the mutation, no retries.
- Every new route or tool adds **negative authorization tests** (no upstream call and no data on denial).
- Every new tool follows the [tool conventions](docs/dev/tool-conventions.md) (names, output contract, errors, paging,
  costs); the naming and description lints must pass without exceptions.
- Security-relevant change → update [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) in the same PR.
- A decision that contradicts an ADR needs a new ADR (supersede, don't edit history).
- A new lesson (review finding, live-test surprise, client quirk) → add it to `docs/LESSONS-LEARNED.md` in the same PR.
- Do not change task status for tasks you are not working on.

## Definition of done

- Every acceptance criterion is ticked and the task is set to `status: review`.
- Lint, typecheck and tests are green (`pnpm lint && pnpm typecheck && pnpm test`) and generated references are
  refreshed.
- The pages listed under *Docs to update* changed, and documented commands still run (L-133).
- Commits follow Conventional Commits, mention the task id and carry a DCO sign-off (`git commit -s`).
- The published package changed → a changeset is included.

## Docs and research

- Prefer current official docs: Digital.ai Agility developer documentation, the MCP specification (2026-07-28 and the
  2025-era revisions we still serve), the MCP TypeScript SDK v2, Cloudflare Workers, Node.js.
- Platform facts with sources live in [`docs/RESEARCH.md`](docs/RESEARCH.md). Update it when you learn something new,
  with the date and the source URL. Mark anything not verified against a real instance as *unverified*.
