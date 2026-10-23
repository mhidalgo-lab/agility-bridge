---
id: P4-30
title: "Apply an instance's stored number prefixes when resolving numbers"
phase: 4
status: todo
priority: low
depends_on: [P4-15]
adr: ["0012"]
lessons: [L-057, L-141]
owner: ""
---

# P4-30 — Apply an instance's stored number prefixes when resolving numbers

> Found while building P4-15: `instances.numberPrefixes` is stored, validated, shown and now editable in the panel, but no host
> passes it to `MetadataService` (`prefixOverrides` is only set in tests), so number lookup still learns prefixes from Agility.

## Goal
Make the stored overrides take effect: a `B-` story prefix set by an owner is used when a caller resolves `B-01234`.

## Scope
- Carry the stored (already validated) prefixes on the resolved instance (`InstanceRef` and `EffectiveAccess.instance`; the stdio
  and CLI hosts pass none) and merge them over discovery in `MetadataService.numberPrefixes()`, re-validated on use with the same
  shared validator.
- The prefix cache is per instance and lives about an hour: say so in the guide, or invalidate it on a change where the host can.
- Tests: override wins over discovery, a hostile stored value is ignored, a resolution still confirms with a query (no string-built
  filters, ADR-0012), the Worker and the HTTP host both pass the value.

## Acceptance criteria
- [ ] A stored prefix changes number resolution on the HTTP and Worker hosts; discovery still fills the other types.
- [ ] The panel's note that prefixes are not applied yet is removed.

## Docs to update
- docs/guide/admin-panel.md, docs/RESEARCH.md (prefix behaviour)

## Out of scope
- Learning prefixes into storage automatically.
