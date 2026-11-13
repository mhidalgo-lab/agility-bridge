---
id: P9-24
title: Opt-in images embedded in descriptions and comments
phase: 9
status: todo
priority: medium
depends_on: []
adr: ["0011", "0015"]
lessons: [L-038]
owner: ""
---

# P9-24 — Opt-in images embedded in descriptions and comments

## Goal
A user can see the screenshots pasted into a work item, the most common evidence in a defect, without leaving the MCP
client. Today the output shaper replaces every `<img>` with `[image]` and drops its source (`output/text.ts`), and
`get_attachment` only covers `Attachment` assets with text types. A live check on 2026-11-13 found a defect with four
pasted screenshots, `Attachments.@Count = 0` and `EmbeddedImages.@Count = 0`: nothing in the tool set can reach them.

## Scope
- **Spike first (live, read-only tenant):** record in `docs/RESEARCH.md` what an `<img src>` in a rich-text field looks
  like (`embedded.img/<id>`, an absolute instance URL, a `data:` URI, an external host), why `EmbeddedImages` can be
  empty while the field holds images, which endpoint serves the bytes, and the content types it returns. Mark anything
  not seen live as *unverified*.
- **New ADR** extending ADR-0015: an image is returned as an MCP `image` content block (base64 + MIME type), never as a
  URL, and carries the same untrusted-data framing in the text block next to it (the picture can hold injected text).
- The shaper keeps a stable reference per image instead of dropping it: `[image 1]`, `[image 2]`, … in reading order,
  with the ids listed in `structuredContent` (no URL is ever returned).
- `get_embedded_image(asset, image)`: one image of an asset in scope, by the reference from the text.
  - In the opt-in `attachments` group behind a new workspace limit `imageDownload` (off by default; a grant can only turn
    it off), with `imageMaxBytes` (default 2 MiB, a grant can only lower it); admin limits form, stdio settings
    (`AB_IMAGE_DOWNLOAD`, `AB_IMAGE_MAX_BYTES`) and generated references agree. The resolver drops the tool when off and
    the handler refuses too (`AB_TOOL_DISABLED`).
  - Scope verified through the parent asset (shared resolver, project predicate, row recheck) before any content request.
  - Only the configured instance's own image endpoint, with the path built from a validated id; external hosts are never
    fetched (no SSRF). `data:` URIs are decoded locally under the same caps.
  - Allowlist `image/png`, `image/jpeg`, `image/gif`, `image/webp`, checked on the response header **and** the magic
    bytes; SVG and anything else refused. Size counted on the stream, not from `Content-Length`.
  - Spends from the call budget; every download audited (asset number, image id, size, type, never the bytes); stdio
    logs a structured stderr line.
- `get_work_item` (and `get_conversations` for comment bodies) say how many images the field holds and whether
  `get_embedded_image` is available, so the model knows to ask for them.

## Acceptance criteria
- [ ] RESEARCH.md records the live findings with date and source; the ADR is accepted.
- [ ] With `imageDownload` off (the default), `get_embedded_image` is absent from `tools/list` and no image request is
      made.
- [ ] Out-of-scope asset, an image id that does not belong to the asset, an external `src`, SVG, a content type lying
      about its bytes, an oversize stream and a disabled grant are refused before any bytes are returned, with no
      upstream content request on scope denial (negative tests).
- [ ] An allowed image comes back as an `image` content block with the untrusted-data framing; the text output of every
      tool shows numbered `[image N]` references and never a URL.
- [ ] Each download writes an audit entry without the content; the call budget is charged.
- [ ] Live: a screenshot from a defect description is returned on the read-only tenant (shapes only in the test log).
- [ ] THREAT_MODEL A8 (and A1 for injected text in pictures) updated.

## Security notes
THREAT_MODEL A1 (prompt injection, here inside a picture), A8 (attachment download), T4 (no URL built from caller
strings), T3 (scope through the parent asset). Images are untrusted Agility data on every path.

## Lessons applied
- L-038 — the new output path (image blocks, image references in text and `structuredContent`) goes through the shaper
  and the envelope like every other path.

## Docs to update
- `docs/RESEARCH.md`, a new ADR, `docs/THREAT_MODEL.md`, `docs/dev/tool-conventions.md` (image content blocks),
  the tools reference, the workspace-limits and stdio configuration pages.

## Out of scope
- OCR or describing images server side.
- Images inside `Attachment` assets (could reuse this path later; a follow-up task if wanted).
- Writing or uploading images.
