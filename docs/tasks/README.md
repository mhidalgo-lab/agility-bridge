# Tasks

Every unit of planned work is **one Markdown file**. The file is the single source of truth for that task's status
([ADR-0001](../adr/0001-markdown-planning.md)).

## Layout

```
docs/tasks/
  phase-0-foundations/P0-01-repo-bootstrap.md
  phase-1-core-stdio/P1-01-…md
  …
  _template.md
```

## Front matter

```yaml
---
id: P1-04            # PHASE-NN (NNN after 99), never reused
title: Query builder, safety and limits   # quote it if it contains ": " ("Tools: …")
phase: 1
status: todo         # todo | in-progress | blocked | review | done | dropped
priority: high       # high | medium | low
depends_on: [P1-03]  # task ids that must be `done` first
adr: ["0012"]        # related ADRs (optional)
lessons: [L-057]     # lessons from docs/LESSONS-LEARNED.md this task must apply (optional)
owner: ""            # human or agent working on it (optional)
---
```

`pnpm tasks lint` (part of `pnpm lint`, so CI runs it) checks every task file: the id format, that the file name
starts with the id and sits in the folder of its phase, the status and priority values, that `depends_on` ids exist and
form no cycle, that each `adr` has a `docs/adr/NNNN-*.md` file and each lesson an `**L-NNN — …**` entry in
`docs/LESSONS-LEARNED.md`, and that the ROADMAP index is current.

| Command | What it does |
|---|---|
| `pnpm tasks next [--all]` | The next task to work on (lowest phase, then highest priority, then id; `--all` lists every candidate) |
| `pnpm tasks list [--phase N] [--status S]` | Tasks, optionally filtered |
| `pnpm tasks graph` | The dependency graph as a Mermaid flowchart |
| `pnpm tasks index` | Regenerates the task index in `docs/ROADMAP.md` between the `tasks:start`/`tasks:end` markers |
| `pnpm tasks lint` | Validates the front matter and the index (above) |

## Rules for humans and agents

1. **Choose** the lowest-phase, highest-priority task whose dependencies are all `done` — `pnpm tasks next` (add
   `--all` to see every candidate), `pnpm tasks list --phase 1 --status todo`, or `pnpm tasks graph` for a Mermaid view.
2. **Claim it**: set `status: in-progress` and `owner`, on a branch named `task/<ID>-<slug>`.
3. **Read first**: the ADRs listed in `adr` and the lessons listed in `lessons`.
4. **Stay in scope**: anything extra becomes a new task file rather than a bigger PR.
5. **Close it**: tick the acceptance criteria, update the *Docs to update* pages (and
   [THREAT_MODEL.md](../THREAT_MODEL.md) when security is touched), record new lessons in
   [LESSONS-LEARNED.md](../LESSONS-LEARNED.md), set `status: review` (`done` once merged) and regenerate the index with
   `pnpm tasks index`.
6. **Blocked?** Set `status: blocked` and explain why in a `## Blocker` section.
7. **Later phases are sketches**: tasks marked for refinement get a scope and acceptance-criteria pass, committed on its
   own, before work starts; large ones are split into several tasks at that point.
8. **Commits**: Conventional Commits naming the task id, e.g. `feat(core): bind query values through with (P1-04)`,
   always signed off for the DCO (`git commit -s`).
9. **Phase reviews**: every phase ends with a review and live-verification task; its findings become new tasks in the
   same phase folder (next free number), so the plan shows what is left before the release.

## Phases

| Phase | Folder | Theme | Release |
|---|---|---|---|
| 0 | `phase-0-foundations` | Repo, community, CI, security tooling, **risk spikes**, tool contract, live-test harness | — |
| 1 | `phase-1-core-stdio` | Core engine, Agility client, query safety, read tools for every asset type, local stdio | v0.1 |
| 2 | `phase-2-access-http` | Storage, encryption, access model, device tokens, self-hosted HTTP, audit, admin API | v0.2 |
| 3 | `phase-3-cloudflare` | Cloudflare Worker deployment | v0.3 |
| 4 | `phase-4-identity-admin` | Google / GitHub / Cloudflare Access / OIDC sign-in, admin panel, self-service tokens | v0.4 |
| 5 | `phase-5-oauth` | OAuth 2.1 for MCP clients (claude.ai web, mobile, IDEs) | v0.5 |
| 6 | `phase-6-tool-breadth` | Typed tools for every workflow, reports, prompts, resources, evals | v0.6 |
| 7 | `phase-7-writes` | Opt-in write tools with human approval | v0.7 |
| 8 | `phase-8-power-features` | Cache, deep links, MCP Apps, doctor, plugins, telemetry, keychain, quotas, Tasks | v0.8–0.9 |
| 9 | `phase-9-hardening-launch` | Threat-model review, external review, performance, docs site, support policy | **v1.0** |

See [`../ROADMAP.md`](../ROADMAP.md) for the full index.
