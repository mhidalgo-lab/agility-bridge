---
"agility-bridge": minor
---

Collaboration tools: `get_conversations` (comments of an asset, newest first, paged), `list_attachments` (attachment
metadata and external links as text) and the opt-in `get_attachment` (text of one attachment, off by default in its own
`attachments` group). The download is enabled per workspace (`attachmentDownload`, `attachmentMaxBytes` limits; a grant
can only turn it off or lower it) or with `AB_ATTACHMENT_DOWNLOAD`, `AB_ATTACHMENT_MAX_BYTES` and `AB_ATTACHMENT_TYPES` in
stdio; it checks scope through the parent asset, the content type on the metadata and the response, counts the size on
the stream, and is audited.
