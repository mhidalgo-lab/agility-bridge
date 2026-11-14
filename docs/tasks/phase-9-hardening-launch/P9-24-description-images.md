---
id: P9-24
title: Opt-in images embedded in descriptions and comments
phase: 9
status: review
priority: medium
depends_on: []
adr: ["0011", "0015", "0019"]
lessons: [L-038, L-505, L-506]
owner: "claude (agent)"
---

# P9-24 — Opt-in images embedded in descriptions and comments

## Goal
A user can see the screenshots pasted into a work item, the most common evidence in a defect, without leaving the MCP
client. The output shaper replaced every `<img>` with `[image]` and dropped its source, and `get_attachment` only covers
`Attachment` assets with text types. A live check on 2026-11-13 found a defect with four pasted screenshots,
`Attachments.@Count = 0` and `EmbeddedImages.@Count = 0`: nothing in the tool set could reach them.

> Refined 2026-11-14 after the spike: the tool is in its own group `images` (not `attachments`), so the image switch is
> independent of the attachment switch; comments are out of scope (none of the latest 300 held an image).

## Scope
- **Spike (live, read-only tenant), recorded in RESEARCH:** sources are absolute `embedded.img/<id>` URLs on the instance
  (rarely `downloadblob.img/<token>`, `data:` URIs, outside addresses); `data-oid` is `undefined` and `EmbeddedImages` is
  unreliable; `embedded.img` returns the image to the bearer token.
- **ADR-0019** extends ADR-0015: images are MCP `image` content blocks, never URLs, with an untrusted-data note.
- The shaper numbers images `[image N]` / `[image N: alt]`; `imageSources()` lists sources in the same order (same
  tokenizer). Long `data:` images are parsed instead of spilling base64 into the text.
- `get_embedded_image(asset, image, field = description | acceptance_criteria)` in the opt-in group `images`, behind the
  workspace limit `imageDownload` (off by default, a grant can only turn it off) and `imageMaxBytes` (default 1 MiB, a
  grant can only lower it; also bounded by the response cap once base64-encoded). Admin limits form, auth policy and
  resolver, stdio (`AB_IMAGE_DOWNLOAD`, `AB_IMAGE_MAX_BYTES`, YAML `images:`) and the generated references agree.
- Authorization by reference: the asset through the scope-checked resolver, its field with the workspace predicate and
  row recheck, the Nth image of that field. Only `https` sources on the instance origin and base path that are exactly
  `embedded.img/<digits>` or `downloadblob.img/<alnum>` are fetched, by a path rebuilt from the validated id; `data:`
  images are decoded locally; anything else is refused before any request.
- PNG, JPEG, GIF, WebP only, on the response header and the magic bytes (they must agree); SVG never; size counted on the
  stream. Budgeted (cost 12); each download audited (asset number, endpoint and id, size, type).
- The live guard allows `GET embedded.img/<digits>` and `downloadblob.img/<alnum>` (reads), nothing else new.

## Acceptance criteria
- [x] RESEARCH.md records the live findings with date and source; ADR-0019 is accepted.
- [x] With `imageDownload` off (the default), `get_embedded_image` is absent from `tools/list` (resolver, stdio, HTTP)
      and the handler refuses with no request at all.
- [x] Out-of-scope asset, an outside or non-image address, a query string, SVG or another type, bytes that are not the
      declared type, an oversize stream or inline image, an index past the last image and a disabled grant are refused
      before any image is returned, with no image request on scope or address denial (negative tests).
- [x] An allowed image comes back as an `image` content block with the untrusted-data note; `[image N]` in
      `get_work_item` is image N here; no instance image URL is returned.
- [x] Each download writes an audit entry without the bytes (HTTP audit row, stdio log); the call budget is charged and
      the cost is pinned (worst-case fixture, bench baseline).
- [x] Live: a screenshot from a recent defect's description is returned in a workspace restricted to its one project
      (shapes only); all four images of the reported defect fetched (108–353 KB, 6 requests each).
- [x] THREAT_MODEL A8 updated (A1 named for text inside pictures); L-506 recorded; changeset added.

## Security notes
THREAT_MODEL A1 (text inside a picture), A8 (download), T3 (scope through the asset and its own field), T4 (no URL from
the caller, no fetch outside the instance's two image endpoints). Images are untrusted Agility data on every path.

## Lessons applied
- L-038 — the text block of the result goes through the shaper and carries the untrusted-data note.
- L-505 — the live check asserts on a real image of a real defect, not on shapes of metadata only.
- L-506 — authorization by the reference in an in-scope field, not by the unreliable `EmbeddedImages` relation.

## Docs to update
- `docs/RESEARCH.md`, ADR-0019 (+ index), `docs/THREAT_MODEL.md`, `docs/dev/tool-conventions.md`,
  `docs/guide/configuration.md`, `docs/reference/tool-catalogue.md`, `docs/ARCHITECTURE.md`, the tools and performance
  references (generated), `docs/LESSONS-LEARNED.md`.

## Out of scope
- OCR or describing images server side.
- Images inside `Attachment` assets and inside comments (a follow-up task if wanted).
- Writing or uploading images.
