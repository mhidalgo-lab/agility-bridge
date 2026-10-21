# agility-bridge

> **Status: Phase 1 (pre-release).** The local stdio server works: 13 read-only tools for every asset type, with
> bound queries, workspace scope and untrusted-data handling. v0.1 is the first npm release; remote modes, writes and
> reports follow in later phases ([roadmap](docs/ROADMAP.md)). Start with the [quickstart](docs/guide/quickstart-local.md).

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents — GitHub Copilot
(VS Code, JetBrains, CLI), Claude (Code, Desktop, claude.ai, mobile), Cursor, Windsurf and others — work with
**Digital.ai Agility** through its public APIs, using **each member's own access token**.

It is meant to cover **every kind of Agility asset**, not just stories: backlog items, defects (`D-`), tasks (`TK-`),
tests (`AT-`), epics and portfolio items, issues, requests, regression tests, plans and suites, test sets, sprints,
teams, members, Agility projects, every other asset type your instance exposes, and `Custom_` fields. As of October 2026 no maintained open-source
MCP server for Digital.ai Agility exists ([research](docs/RESEARCH.md#7-prior-art)).

## Planned features

**Run it anywhere**

- **Local stdio** (`npx agility-bridge`): your MCP client starts it with your instance URL and access token; no account
  or database needed.
- **Self-hosted HTTP** (`agility-bridge serve`, Node or Docker, SQLite): a team or company server, even next to an
  on-premises Agility instance with an internal CA, with one URL per workspace (`/w/{slug}/mcp`).
- **Cloudflare Worker** (D1): reachable from every device, including claude.ai and phones, without running a server.

**Share it safely across teams**

- **Bring-your-own-token by default**: every member uses their own Agility access token, so Agility's permissions and
  change history stay per person. Shared tokens are allowed only for read-only access.
- **Workspaces, grants and per-device tokens**: decide which Agility projects, asset types and tools each person or
  service may use, with limits and expiry; revoke one device at a time.
- Tokens **encrypted at rest** under a master key you hold, an **audit log**, rate limits and quotas that protect your
  Agility tenant.
- **Sign-in** with Google, GitHub, Cloudflare Access or any OIDC provider; an **admin panel** that works on a phone;
  **OAuth 2.1** for claude.ai, mobile and IDE clients.

**Tools built for agents**

- A validated **generic query tool** for any asset type: structured filters with safely bound values, enforced scope and
  limits — never a raw API passthrough.
- Typed tools for the daily questions: search and open work items, my work, teams, sprints, portfolio trees,
  conversations, history, and reports such as sprint health, stand-up summaries, release readiness, defect triage and
  backlog-item quality ([tool catalogue](docs/reference/tool-catalogue.md)).
- MCP **prompts** for common workflows, **resources** with the instance schema, **MCP Apps** charts and **MCP Tasks**
  for long reports.
- Compact output, honest partial results, and every piece of Agility content treated as **untrusted data**.

**Opt-in writes with a human in the loop**

- Comments, status changes, effort, owners, sprint moves, creating work items, field updates, close and reopen — **off by
  default**, enabled per workspace and grant, applied to one item at a time, and **approved by a person** for every
  change (in the client, or on an approval page when the client cannot ask).

## Quick start

See the [quickstart](docs/guide/quickstart-local.md) and the [client setup guide](docs/guide/clients.md); the tools are
listed in the [tool reference](docs/reference/tools.md).

## Documentation

- **Plan:** [roadmap and task index](docs/ROADMAP.md) · [how tasks work](docs/tasks/README.md) ·
  [pending decisions](docs/pending-decisions/phase-0.md)
- **Design:** [architecture](docs/ARCHITECTURE.md) · [decisions (ADRs)](docs/adr/README.md) ·
  [tool conventions](docs/dev/tool-conventions.md) · [tool catalogue](docs/reference/tool-catalogue.md) ·
  [client compatibility](docs/reference/client-compatibility.md)
- **Research:** [Agility APIs, MCP, OAuth and platform facts](docs/RESEARCH.md)
- **Security:** [threat model](docs/THREAT_MODEL.md)
- **Lessons learned:** [engineering rules and known failure modes](docs/LESSONS-LEARNED.md)
- **Contributors and AI agents:** [contributing](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) ·
  [code of conduct](CODE_OF_CONDUCT.md)
- **Security policy:** [SECURITY.md](SECURITY.md) (report vulnerabilities privately) ·
  [repository settings](docs/security/repo-settings.md)

## Development

A pnpm monorepo in TypeScript ([ADR-0004](docs/adr/0004-typescript-runtime-agnostic-core.md)): `packages/*` hold the
runtime-agnostic core and adapters, `apps/cli` is the published `agility-bridge` command and `apps/worker` the
Cloudflare Worker. You need Node.js 24 or later; pnpm is pinned through `packageManager`.

```sh
corepack enable
pnpm install          # also installs the git hooks (Biome on commit, DCO sign-off check)
pnpm lint             # Biome, web-standard import check, SPDX headers, workflow hardening rules
pnpm typecheck
pnpm test
pnpm build
```

Commits follow Conventional Commits and carry a DCO sign-off (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md)
and [AGENTS.md](AGENTS.md).

## Data and terms

agility-bridge connects to **your** Agility instance with **your** credentials through Digital.ai's documented APIs. It
never builds a corpus of your Agility content (titles, descriptions, comments): content is held only in short-lived,
scoped caches and, for long reports, short-lived encrypted task results. Remote deployments keep metadata — encrypted
access tokens, the member each token belongs to, and an audit log of who used which tool on which asset numbers (90 days
by default) — described in the data-protection inventory (task P2-15). It trains nothing and sends no telemetry to its
maintainers. Tool results are sent to whatever model your MCP client uses. Use is subject to your organisation's Agility license and
to Digital.ai's Terms of Use and Acceptable Use Policy.

## Disclaimer

agility-bridge is an unofficial, community project. It is not affiliated with, endorsed by, or supported by Digital.ai.
Digital.ai, Agility and VersionOne are trademarks of their respective owners.

## License

[Apache-2.0](LICENSE) (see also [NOTICE](NOTICE)), with DCO sign-off for contributions
([ADR-0003](docs/adr/0003-license-apache-2.md)).
