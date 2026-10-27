---
id: P6-19
title: Verify the attachment download on a writable sandbox
phase: 6
status: todo
priority: medium
depends_on: [P6-04]
adr: ["0015"]
lessons: [L-281, L-283]
owner: ""
---

# P6-19 — Verify the attachment download on a writable sandbox

## Goal
Check against a real Agility instance what P6-04 could only check on fixtures, because the read-only tenant's live
guard allows no `attachments.img` request: the content endpoint, the content type it answers with and the size
attribute.

## Scope
- On the writable sandbox (owner checklist, before Phase 7): upload small synthetic text attachments (plain text, CSV,
  JSON, one with no content type, one PNG) and read them with `get_attachment`.
- Confirm or correct the endpoint spelling (`attachments.img`, the developer library's name; `attachment.img` appears in
  SDK examples), the response `Content-Type` against the stored one, behaviour of a 404 for an attachment the member
  cannot see, and whether `Content-Length` is sent.
- Record the results (dated, with sources) in `docs/RESEARCH.md`, mark D-87's unverified points, and add the fixtures
  that reproduce any surprise.

## Acceptance criteria
- [ ] A text attachment of each allowed type is returned inside the envelope on the sandbox; a PNG, an HTML file and an
      attachment without a content type are refused with no content returned.
- [ ] The endpoint spelling and the content-type behaviour are recorded in RESEARCH with the date and version.
- [ ] If Agility serves a different type than it stores (for example `application/octet-stream`), the response check is
      adjusted or the limitation documented in the configuration guide.

## Security notes
THREAT_MODEL A8.

## Lessons applied
- L-281 — type checked on the metadata and the response, size counted on the stream.
- L-283 — optional attributes are selected from metadata; the size may be unknown.

## Docs to update
- docs/RESEARCH.md, docs/guide/configuration.md, docs/pending-decisions/phase-6.md (D-87).

## Out of scope
- Attachment upload (never offered in 1.0), extracting text from PDFs or office documents.
