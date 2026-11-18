---
"agility-bridge": minor
---

Comment images (P9-27): `get_conversations` now lists the images attached to each comment and reply as `[image N: name]`, and `get_embedded_image` returns one of them as an MCP image block with `field: "comment"` and the comment id (`Expression:1234`). Agility stores these screenshots as assets of the comment, not in its text, so no tool could reach them before. Same opt-in switch (`imageDownload`), size cap, type checks and audit as pasted images; the comment must mention the asset in scope or reply to a comment that does, and the image is read only from the instance's `expressionimage.img` endpoint.
