---
'agility-bridge': patch
---

Device tokens are resolved with one database round trip instead of four (the token and the records its access reads
in one batch).
