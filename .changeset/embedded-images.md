---
"agility-bridge": minor
---

Pasted images (P9-24, ADR-0019): rich text now shows images as `[image N]`, and the new opt-in tool `get_embedded_image` returns image N of a work item's description or acceptance criteria as an MCP image block, so screenshots in a defect can be seen and described. Off by default: turn it on per workspace with the `imageDownload` limit (a grant can only turn it off; `imageMaxBytes`, default 1 MiB, can only be lowered), or `AB_IMAGE_DOWNLOAD=on` / YAML `images:` in stdio. The caller never passes a URL: only images of an asset in scope are read, only from the instance's own `embedded.img` and `downloadblob.img` endpoints (a `data:` image is decoded locally), PNG, JPEG, GIF and WebP only (checked on header and bytes), size-capped and audited. A long `data:` image no longer spills its base64 into the text.
