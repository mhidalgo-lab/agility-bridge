---
id: P6-04
title: Collaboration tools (conversations, links, attachments)
phase: 6
status: todo
priority: medium
depends_on: [P2-17]
adr: ["0015"]
lessons: [L-038, L-056]
owner: ""
---

# P6-04 — Collaboration tools (conversations, links, attachments)

> Later-phase task: **refine scope and acceptance criteria before starting** (tasks/README rule 7).

## Goal
Read the discussion around a work item safely, and, where a workspace opts in, the text content of its attachments.

## Decisions
- D-08 (2026-10-19): an opt-in attachment-download tool ships in 1.0, off by default.

## Scope
- `get_conversations` (comments newest first, paged, enveloped) and `list_attachments` (metadata only); external links
  listed as text.
- `get_attachment` in its own `attachments` group, off by default, enabled per workspace and grant
  (`AB_ATTACHMENT_DOWNLOAD` in stdio): one attachment of an asset in scope, fetched through `attachments.img`.
  - Scope verified through the attachment's parent asset before any content request.
  - Content-type allowlist (default text types: `text/plain`, `text/markdown`, `text/csv`, `application/json`), checked
    on both the metadata and the response; size cap (default 1 MiB, `AB_ATTACHMENT_MAX_BYTES`) enforced on the stream,
    not on the declared length.
  - Returned as text inside the untrusted-data envelope; never rendered, executed or turned into a public link.
  - Counts against the call budget; every download audited (asset number, attachment id, size, content type).

## Acceptance criteria
- [ ] Poisoned comments, attachment names and attachment content stay inside the envelope.
- [ ] With download off (the default), `get_attachment` is absent from `tools/list` and no attachment content is fetched.
- [ ] Disallowed content type, oversize stream (declared length lying), attachment of an out-of-scope asset and a
      disabled grant are refused before content is returned, with no upstream content request on denial (negative tests).
- [ ] Each download writes an audit entry.

## Security notes
THREAT_MODEL A1, A8.

## Lessons applied
- L-038 — Everything that came from upstream is untrusted.
- L-056 — Reads never create public links.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
