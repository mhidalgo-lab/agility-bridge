---
id: P6-09
title: MCP resources
phase: 6
status: review
priority: medium
depends_on: [P2-17]
adr: ["0015"]
lessons: [L-153, L-038, L-013, L-121]
owner: "claude-agent"
---

# P6-09 — MCP resources

## Goal
Reference material the agent can read on demand: filter vocabulary, instance schema, allowed projects, rubric. Resources
are registered from one manifest that prompts (P6-08) and recipe resources (P6-03, P6-06) extend.

## Scope
- **One manifest** (`packages/core/src/manifest.ts`, `resources.ts`): each entry has a stable id, URI (or URI template),
  title, description, MIME type, the tools it is **served through** (`uses`) and a reader. The manifest drives
  registration, `resources/list`, `resources/templates/list`, access checks, the generated reference and the tests
  (L-153). The availability rule (`isAvailable(entry, allowedToolNames)`) is shared so prompts reuse it.
- **Served through the tool handlers.** A reader never reaches Agility itself: it runs the declared tools' handlers (input
  parsed by the tool's own schema, same request context, budget, limits, metadata cache and error contract) and returns
  their text, which is already enveloped. A reader can only run tools it declares and that are allowed for the caller.
- **Availability.** A resource is registered, listed and readable only when every tool in `uses` is allowed for the
  workspace and grant; otherwise it does not exist. Static entries (filter vocabulary, rubric) name the tool they describe
  in `uses`, so they follow the same rule (D-93).
- **Audit.** Every read is observed like a tool call (`onToolCall`, action `resource:<id>`): status, duration, requests used,
  asset numbers and masked queries; no content.
- **The five catalogue resources:**
  - `agility-bridge://reference/filters` (uses `query_assets`): the structured filter vocabulary, generated from the compiler's
    operator list, with examples. Static, our own text.
  - `agility-bridge://instance/asset-types` (uses `list_asset_types`): through that tool.
  - `agility-bridge://instance/asset-types/{asset_type}` (uses `describe_asset_type`): through that tool; the template lists
    one URI per readable type, built from the same tool output, so every listed URI is readable (L-153).
  - `agility-bridge://workspace/projects` (uses `list_projects`): the allowed projects as a depth-first tree (a `depth` column),
    built from the tool's rows and shaped through the output shaper.
  - `agility-bridge://rubrics/backlog-item-quality` (uses `get_work_item`): the versioned rubric JSON, defined in core
    (`rubric.ts`) now so `work_item_quality` (P6-07) imports the same object; D-92.
- **Recipe resources** are added by P6-03 and P6-06 as manifest entries only (documented in `docs/dev/tool-conventions.md`).
- Generated `docs/reference/resources.md` (`pnpm docs:resources`, `--check` in the tests).

## Acceptance criteria
- [x] Every listed resource is readable (test over `resources/list` and the templates), over the 2025-era stateless path.
- [x] A resource is absent from `resources/list` and not readable when the tools it uses are not allowed; a denied asset type
  is refused on read with no upstream call and no data (negative authorization tests).
- [x] Instance strings (project and status names, attribute names) are enveloped on every resource path; poisoned-string probe.
- [x] Reads count against the request budget and limits of the context, are audited like tool calls, and use the metadata cache.
- [x] The rubric is versioned JSON in core and documented for P6-07.
- [x] `docs/reference/resources.md` is generated and checked; tool conventions, THREAT_MODEL A12, a changeset and the lessons
  are done; stdio and HTTP both serve resources.
- [x] Live check (guarded suite): every upstream-reading resource reads and shows only shapes and counts.

## Security notes
THREAT_MODEL A12: instance metadata appears only inside enveloped resource output, never in descriptions of tools or
resources; resource descriptions and the template list are static except the asset type names, which are strict
identifiers from the metadata parser.

## Lessons applied
- L-153 — Register prompts and resources from one manifest.
- L-038 — Everything that came from upstream is untrusted.
- L-013 — No request data in module state: readers take the per-request context.
- L-121 — Negative authorization tests that fail when the fix is reverted.

## Docs to update
- docs/reference/resources.md (new, generated)
- docs/dev/tool-conventions.md, docs/THREAT_MODEL.md (A12), docs/reference/tool-catalogue.md

## Out of scope
- Prompts (P6-08) and recipe resources (P6-03, P6-06), resource subscriptions and `listChanged` pushes.
- Anything not listed under Scope.

## Outcome
- Built as scoped: `manifest.ts` (entry shape, `availableEntries`), `resources.ts` (`RESOURCE_MANIFEST`, readers),
  `rubric.ts`, registration in `buildMcpServer` (default manifest, so stdio and HTTP need no change), `scripts/resource-reference.ts`
  with a test that fails when `docs/reference/resources.md` is stale, `test/resources.test.ts` (mutation-checked: making
  `isAvailable` always true fails four tests) and `live/resources.live.test.ts` (ran against the read-only tenant: passes,
  counts only).
- Decisions D-92 (rubric in core now), D-93 (static entries follow their tool), D-94 (audited as `tool_call`, action
  `resource:<id>`); lessons L-288 - L-291.
- Prompts (P6-08) add a `PROMPT_MANIFEST` of `ManifestEntry` and reuse `availableEntries`; recipe resources add entries.
- Follow-ups: none needed beyond P6-07 adding `work_item_quality` to the rubric resource's `uses`.
