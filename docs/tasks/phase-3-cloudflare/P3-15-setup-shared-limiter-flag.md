---
id: P3-15
title: A cf:setup flag for the Durable Object limiter
phase: 3
status: todo
priority: low
depends_on: [P3-12, P3-05]
adr: ["0010"]
lessons: [L-478]
owner: ""
---

# P3-15 — A cf:setup flag for the Durable Object limiter

> Created by P3-12: the object is opt-in by hand-editing `wrangler.jsonc`; `cf:setup` could do it and keep it across runs.

## Goal
`pnpm cf:setup --shared-limiter on` adds the `RL_SHARED` binding and the `new_sqlite_classes` migration to the deployment's local
config, keeps them on later runs (like `--oauth`), and `--shared-limiter off` removes the binding (the migration stays, a deleted
class is a separate decision).

## Scope
- The flag, written to the local config only; dry-run output; a test on the generated config.
- The deployment guide and the limits guide show the flag next to the manual snippet.

## Acceptance criteria
- [ ] The local config gains and keeps the binding and migration; a run without the flag keeps them; `off` removes the binding.
- [ ] A test on the pure config builder (no Cloudflare calls).

## Security notes
THREAT_MODEL T1, T20, T34: a local config of another deployment is still refused.

## Lessons applied
- L-478 — The class is exported by the Worker always; only the binding is opt-in.

## Docs to update
- docs/guide/cloudflare-deploy.md, docs/guide/cloudflare-limits.md

## Out of scope
- Making the object the default; deleting an object class.
