---
id: P9-27
title: Opt-in images attached to comments
phase: 9
status: review
priority: medium
depends_on: [P9-24, P9-25]
adr: ["0015", "0019"]
lessons: [L-038, L-505, L-506, L-507]
owner: "claude (agent)"
---

# P9-27 — Opt-in images attached to comments

## Goal
A user can see the screenshots attached to the comments of a work item, the usual evidence when a defect bounces between
QA and development. P9-24 left comments out because none of the latest 300 held an `<img>`, but Agility does not paste a
comment's images into its text: it stores each one as an `ExpressionImage` asset of the comment. A user's defect (2026-11-17)
showed two such screenshots in the UI that no tool could reach, and `get_conversations` did not even say they existed.

## Scope
- **Spike (live, read-only tenant, 2026-11-17), recorded in RESEARCH:** `Expression.ExpressionImages` (multi, →
  `ExpressionImage`); `ExpressionImage` has `Name`, `ContentType`, `Content` (blob: `<basePath>/expressionimage.img/<id>`,
  the asset's own id) and `Expression` (→ its comment). `GET expressionimage.img/<id>` with the bearer token: `200
  image/png`, valid PNG magic, `Cache-Control: private`; without it `401`. 6 of the latest 300 comments held images (up to
  4); none had an `<img>` in `Content`. `ExpressionImages` and `ExpressionImages.Name` pair by position (59 of 59 checked),
  but the relation order is not always id order (2 of 20 comments).
- `get_conversations` lists each comment's and reply's images as `images` (`[image N: name]`), names untrusted and shaped;
  image N is the Nth `ExpressionImage` by ascending id.
- `get_embedded_image` gains `field = comment` with a `comment` argument (the `Expression:<id>` shown by
  `get_conversations`). Authorization by reference: the asset through the scope-checked resolver; the comment must mention
  the asset or reply to a comment that does (the `get_conversations` predicate), checked by the query and the row
  recheck; the image is the Nth of that comment's `ExpressionImages`. The bytes come from `expressionimage.img/<id>`, a
  path rebuilt from the validated id; no caller URL or id of an image is ever accepted.
- Same switch (`imageDownload`), size cap, type checks (header and magic bytes agree), budget (cost 12) and audit as
  P9-24. The live guard allows `GET expressionimage.img/<digits>` and nothing else new.

## Acceptance criteria
- [x] RESEARCH.md records the live findings with date and source; L-507 corrects the P9-24 finding.
- [x] `get_conversations` shows `[image N: name]` for comments and replies with images, nothing for those without.
- [x] `field: comment` without `comment`, `comment` with another field, a comment that does not mention the asset (or
      reply to one that does), an out-of-scope asset, an index past the last image and image download off are refused
      with no image request (negative tests).
- [x] An allowed comment image comes back as an `image` content block with the untrusted-data note; `[image N]` in
      `get_conversations` is image N here; no instance image URL is returned; the download is audited.
- [x] The cost stays pinned: a cold comment-image call stays within cost 12 (test); `get_conversations` cold goes from 9
      to 10 requests (the `ExpressionImage` metadata), within its cost 11, baseline and performance reference updated.
- [x] Live: both screenshots of the comments of the reported defect are fetched (shapes only): PNG, 116 KB and 291 KB,
      8 requests each cold, in a workspace restricted to its project; its comment without images is refused.
- [x] THREAT_MODEL A8 updated; changeset added; generated references refreshed.

## Security notes
THREAT_MODEL A1 (text inside a picture), A8 (download), T3 (scope through the asset and a comment that mentions it), T4
(no URL or image id from the caller; one more fixed instance endpoint, rebuilt from a validated id).

## Lessons applied
- L-038 — the text block goes through the shaper and carries the untrusted-data note; image names are untrusted.
- L-505 — the live check fetches real images of a real defect's comments.
- L-506 — the image is reached through the comment the caller saw, itself reached through the asset in scope.
- L-507 — "no images found" is only as good as the place you looked: check every relation that can hold them.

## Docs to update
- `docs/RESEARCH.md`, `docs/THREAT_MODEL.md`, ADR-0019 (note), `docs/guide/configuration.md`, `docs/ARCHITECTURE.md`,
  `docs/dev/tool-conventions.md`, `docs/reference/tool-catalogue.md`, the tools and performance references,
  `docs/LESSONS-LEARNED.md`.

## Out of scope
- Images inside `Attachment` assets (still text-only `get_attachment`).
- Writing or uploading comment images.
