---
id: P1-03
title: Metadata service (meta.v1) and schema snapshot
phase: 1
status: todo
priority: high
depends_on: [P1-02]
adr: ["0011"]
lessons: [L-052, L-053, L-141, L-142, L-148]
owner: ""
---

# P1-03 — Metadata service (meta.v1) and schema snapshot

## Goal
Know each instance's asset types, attributes, operations, statuses and number prefixes, so every request can be validated before it is sent.

## Scope
- Fetch and parse `meta.v1` as JSON (one asset type at a time on Workers: the whole schema is 5.1 MB, P0-06); model asset types (name, base, abstract), attributes (type, relation target, multi-value, custom, read-only, required) and operations.
- Per-instance cache with a TTL (default 1 hour) keyed by the `ETag` (`"<version>.<schema stamp>"`, P0-06).
- Number-prefix discovery (sampling per numbered type) with configuration overrides.
- Status lists per asset type (and team workflow where the instance has one).
- Field tiers per asset type (`minimal`, `default`, `full`) computed from metadata plus overrides.
- Scope strategy per asset type (direct, derived through a parent path, workspace-bounded, global, denied — ARCHITECTURE §6.3), from metadata plus the P0-06 findings; unclassified types are denied.
- Sanitised snapshot generator and a CI drift check against the committed fixture.
- Metadata strings are untrusted: they appear only in enveloped output, never in tool definitions (THREAT_MODEL A12).

## Acceptance criteria
- [ ] Parses the committed snapshot; validates dot paths and downcasts; refuses unknown attributes.
- [ ] Tier computation, prefix discovery (including `B-` and `S-` story prefixes) and scope-strategy classification tested.
- [ ] Drift check script runs in CI against the snapshot.
- [ ] Metadata loading cost is accounted in the budget and cached across calls.

## Security notes
THREAT_MODEL A12.

## Lessons applied
- L-052 — Normalise heterogeneous representations.
- L-053 — Snapshot the upstream schema and detect drift.
- L-141 — Number prefixes vary per instance.
- L-142 — Status, AssetState and rollup category are different things.
- L-148 — Learn the model from metadata, then verify relations live.

## Docs to update
- docs/ARCHITECTURE.md §6.2
- docs/RESEARCH.md §1.6

## Out of scope
- Query compilation (P1-04)
