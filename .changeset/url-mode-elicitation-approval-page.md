---
"agility-bridge": patch
---

URL-mode elicitation for the approval page (P7-46): a client that declares `elicitation.url`, on a connection the server can push a request to (stdio and other 2025-era connections), is asked to open the approval page's link itself. The request is a fixed text and the page's own link; the answer still carries the link, the page and its checks are unchanged, and accepting the request approves nothing. 2026-07-28 requests keep the plain link for now.
