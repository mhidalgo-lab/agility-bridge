---
id: P6-04
title: Collaboration tools (conversations, links, attachments)
phase: 6
status: review
priority: medium
depends_on: [P2-17]
adr: ["0015"]
lessons: [L-038, L-056]
owner: "claude (agent)"
---

# P6-04 — Collaboration tools (conversations, links, attachments)

> Refined 2026-10-27 (tasks/README rule 7): scope and acceptance criteria below are the ones this task is closed against.

## Goal
Read the discussion around a work item safely, and, where a workspace opts in, the text content of its attachments.

## Decisions
- D-08 (2026-10-19): an opt-in attachment-download tool ships in 1.0, off by default.

## Scope
- `get_conversations` (comments newest first, paged, enveloped) and `list_attachments` (metadata only, paged); external
  links (`Link` assets) listed as text on the first page of `list_attachments`, never fetched. Both are in the
  `collaboration` group (on by default, read-only) and verify scope through the parent asset (the shared resolver, then
  the derived project predicate and the row recheck) before any comment or attachment row is requested.
- `get_attachment` in its own `attachments` group, off by default, enabled per workspace and grant
  (`AB_ATTACHMENT_DOWNLOAD` in stdio): one attachment of an asset in scope, fetched through `attachments.img`.
  - The switch is the workspace limit `attachmentDownload` (a grant can only turn it off, like `genericQuery`), with
    `attachmentMaxBytes` (a grant can only lower it); the access resolver drops the tool from `tools/list` and from
    the callable set when it is off, and the handler refuses too (`AB_TOOL_DISABLED`). Stdio: `AB_ATTACHMENT_DOWNLOAD`,
    `AB_ATTACHMENT_MAX_BYTES`, `AB_ATTACHMENT_TYPES`, or `attachments:` in YAML. Types that run or render in a client
    (HTML, SVG, XML, JavaScript) are refused even when listed.
  - Arguments: `asset` and `attachment` (an id from `list_attachments`); the attachment must belong to that asset.
  - Scope verified through the attachment's parent asset before any content request.
  - Content-type allowlist (default text types: `text/plain`, `text/markdown`, `text/csv`, `application/json`), checked
    on both the metadata and the response; size cap (default 1 MiB, `AB_ATTACHMENT_MAX_BYTES`) enforced on the stream,
    not on the declared length.
  - Returned as text inside the untrusted-data envelope; never rendered, executed or turned into a public link.
  - Counts against the call budget; every download audited (asset number, attachment id, size, content type): an audit
    row in HTTP deployments, a structured stderr log line in stdio. Text must be valid UTF-8 without NUL bytes.

## Acceptance criteria
- [x] Poisoned comments, attachment names and attachment content stay inside the envelope.
- [x] With download off (the default), `get_attachment` is absent from `tools/list` and no attachment content is fetched.
- [x] Disallowed content type, oversize stream (declared length lying), attachment of an out-of-scope asset and a
      disabled grant are refused before content is returned, with no upstream content request on denial (negative tests).
- [x] Each download writes an audit entry (HTTP audit row; stdio log line) with asset number, attachment id, size and
      content type, and never the content.
- [x] `get_conversations` and `list_attachments` page without skipping or repeating, answer an out-of-scope asset like a
      missing one, and drop rows outside the workspace even when the upstream ignores the filters.
- [x] The workspace and grant switches, the admin limits form, the stdio settings and the generated references agree;
      THREAT_MODEL A8 is updated.
- [x] Live: conversations and attachment metadata verified on the read-only tenant (shapes and counts only); the
      download itself is verified on fixtures only, because the live guard does not allow `attachments.img`.

## Security notes
THREAT_MODEL A1, A8.

## Lessons applied
- L-038 — Everything that came from upstream is untrusted.
- L-056 — Reads never create public links.

## Docs to update
- docs/reference/tools.md (generated)

## Out of scope
- Anything not listed under Scope.
