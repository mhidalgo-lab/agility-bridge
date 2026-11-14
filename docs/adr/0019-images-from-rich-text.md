# ADR-0019 — Images pasted into rich text are returned as MCP image blocks, found by their number in the text

- **Status:** accepted (owner, 2026-11-14, P9-24 go-ahead)
- **Date:** 2026-11-14
- **Extends:** [ADR-0015](0015-tool-output-contract.md) (tool output contract): a tool may now return image content
  blocks next to its text. ADR-0015 is not edited; this record says what is added.
- **Related:** P9-24, P6-04, [ADR-0011](0011-agility-api-surface.md), [ADR-0012](0012-structured-query-no-raw-passthrough.md),
  THREAT_MODEL A1, A8, T3, T4, L-506

## Context

The most common evidence in a defect is a screenshot pasted into its description. The output shaper turned every `<img>`
into `[image]` and dropped its source, and `get_attachment` only reads `Attachment` assets with text types, so the
screenshots could not be seen at all. Live (2026-11-14): pasted images are `<img src="<instance>/embedded.img/<id>">`
(sometimes `downloadblob.img/<token>`, rarely a `data:` URI, occasionally an outside address); `data-oid` is the literal
`undefined`, and the `EmbeddedImages` relation is empty for about half of the defects that hold images, so neither can
say which asset an image belongs to. `embedded.img` answers the bearer token with the image (`image/png`,
`Cache-Control: private`) and `401` without it.

## Decision

1. **Numbering.** The shaper writes `[image N]` (or `[image N: alt]`) in reading order; `imageSources()` lists the
   sources in the same order from the same tokenizer, so "image N" means one thing in every tool's text.
2. **Authorization by reference.** `get_embedded_image(asset, image, field)` takes no URL and no image id. The server
   resolves the asset through the scope-checked resolver, reads that asset's description (or acceptance criteria) with
   the workspace predicate and row recheck, and takes the Nth image. Seeing the text that references an image is what
   authorizes the image, as in Agility's own UI.
3. **Fetch only from the instance.** A source is fetched only when it is `https`, on the instance's origin, under its base
   path, without query, fragment or credentials, and is exactly `embedded.img/<digits>` or `downloadblob.img/<alnum>`;
   the request path is rebuilt from the validated id, never from the text. A `data:` URI is decoded locally under the same
   caps; anything else is refused before any request (no SSRF, T4).
4. **Type and size.** `image/png`, `image/jpeg`, `image/gif` and `image/webp` only, checked on the response header and on
   the bytes (magic numbers), which must agree; SVG never. The cap is `imageMaxBytes` (default 1 MiB, a grant can only
   lower it) and also the response cap once base64-encoded, counted on the stream.
5. **Output.** One text block (summary and an untrusted-data note: text inside a picture is content, never instructions)
   and one MCP `image` content block (base64, the checked type). No URL is ever returned. `structuredContent` carries the
   index, field, source kind, type and size.
6. **Opt-in.** The tool is in its own group `images`, behind the workspace limit `imageDownload` (off by default; a grant
   can only turn it off; stdio `AB_IMAGE_DOWNLOAD`, YAML `images:`), independent of `attachmentDownload`. The handler
   refuses too when the switch is off. Each download spends from the call budget and writes the download audit record
   (asset number, endpoint and id, size, type; never the bytes).

## Consequences

- Clients that render image blocks show the screenshot; the model can describe it. Text inside a picture is a new
  injection channel (A1); the note and the envelope frame it, and nothing in the server acts on image content.
- A large screenshot can exceed the response cap on Workers Free (512 KiB → about 370 KiB of image); it is refused with a
  size error, never cut.
- `downloadblob.img` and `data:` images are supported on the same rules; images of `Attachment` assets and images in
  comments stay out of scope (none of the latest 300 comments on the live tenant held one).
