# Contributing to agility-bridge

Thanks for your interest! agility-bridge is an unofficial, community MCP server for Digital.ai Agility. This guide
covers how we work. AI coding agents: also read [`AGENTS.md`](AGENTS.md).

## Ground rules

- Be kind — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security issues go through [private reporting](SECURITY.md), never public issues.
- Planned work lives in Markdown task files ([`docs/tasks/`](docs/tasks/README.md)), not GitHub Issues. Issues are for
  bug reports, feature requests and client compatibility reports; maintainers turn accepted ones into task files.
- Never commit secrets (Agility access tokens, `ab_` device tokens, the master key, admin tokens, session cookies) or
  real Agility data. Fixtures are synthetic or sanitised by hand.

## Development setup

Requirements: **Node.js 24 or later** (see `.nvmrc`) and **pnpm** through Corepack (the version is pinned in
`package.json`).

```sh
corepack enable
pnpm install          # also installs the git hooks (lefthook)
pnpm lint             # Biome, web-standard imports, SPDX headers, workflow rules, task files (pnpm tasks lint)
pnpm typecheck
pnpm test
pnpm build
```

### Repository layout

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2 and §9. In short:

- `packages/core`, `packages/storage`, `packages/auth`, `packages/http-app`, `packages/admin-ui` are marked
  `"agilityBridge": { "runtime": "web" }` and may only use **web-standard APIs** (no `node:*` imports, no `process`,
  no `Buffer`). `pnpm lint` enforces this ([ADR-0004](docs/adr/0004-typescript-runtime-agnostic-core.md)).
- `packages/storage-sqlite` (Node), `apps/cli` (the published `agility-bridge` package, Node) and `apps/worker`
  (Cloudflare Workers) hold the runtime-specific code.
- `scripts/` is repository tooling, run directly by Node's built-in TypeScript support.

## Working on a task

1. Pick a task: `pnpm tasks next` (the first `todo` task whose dependencies are all `done`; `--all` lists every
   candidate). See [`docs/tasks/README.md`](docs/tasks/README.md) for every `pnpm tasks` command.
2. Branch: `task/<ID>-<short-name>`, e.g. `task/P1-04-query-compiler`.
3. Set `status: in-progress` and `owner` in the task file.
4. Read the ADRs and lessons the task lists. Stay in scope; extra work becomes a new task file
   (`docs/tasks/_template.md`).
5. Tick the acceptance criteria, update the docs it lists, set `status: review` and run `pnpm tasks index`.
6. Open a pull request using the template.

A new lesson (a review finding, a live-test surprise, a client quirk) goes into
[`docs/LESSONS-LEARNED.md`](docs/LESSONS-LEARNED.md) in the same PR: the next free `L-` number, in the matching
section, with a one-line rule, an optional *Why*, and *Applied in* naming the tasks or docs that follow it.

## Commits and sign-off (DCO)

- [Conventional Commits](https://www.conventionalcommits.org/) with the task id:
  `feat(core): bind query values through with (P1-04)`. Pull requests are squash-merged, so the **PR title** becomes
  the commit on `main` and must be a Conventional Commit too (CI checks it).
- Every commit is signed off under the [Developer Certificate of Origin](https://developercertificate.org/): use
  `git commit -s`, which adds `Signed-off-by: Your Name <you@example.com>`. The commit-msg hook and CI check it.
- Every source file starts with `// SPDX-License-Identifier: Apache-2.0` (after a shebang line, if any).
- A change to the published `agility-bridge` package (`apps/cli`, or a workspace package it bundles) needs a changeset:
  `pnpm changeset`. Internal workspace packages are private and never published.

## Continuous integration

Every pull request runs `.github/workflows/ci.yml` on GitHub-hosted runners. These checks are **required** before a
merge (the rulesets have no bypass, see [`docs/security/repo-settings.md`](docs/security/repo-settings.md)):

| Check | What it runs |
|---|---|
| `Lint, typecheck, test, build (Node 24)` and `(Node 26)` | `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` |
| `Workflow lint` | actionlint, downloaded with a pinned checksum |
| `DCO sign-off` | every commit in the PR has a `Signed-off-by` trailer |
| `Conventional PR title` | the PR title is a Conventional Commit |

`SQLite and CLI (macos-latest / windows-latest, Node 24)` also runs on every PR (node:sqlite and the CLI on the other
operating systems) but is not required.

### Workflow security rules

`scripts/check-workflows.ts` (part of `pnpm lint`) fails the build when a workflow breaks one of these:

- Third-party actions are **pinned by full commit SHA** with a `# vX.Y.Z` comment.
- Top-level `permissions` is `contents: read` (or `{}`); a job widens only the scopes it needs.
- No `pull_request_target`, and no self-hosted runners.
- Every job on a Linux runner starts with `step-security/harden-runner` (egress audit).
- A tool downloaded in CI is verified against a sha256 pinned in the workflow.

Secrets live only in protected environments, never at repository level, and are never available to fork pull requests.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
