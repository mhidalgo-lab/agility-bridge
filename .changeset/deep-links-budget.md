---
"agility-bridge": patch
---

Deep links (P8-40): the instance URL is parsed once per result instead of twice per row, and the links of one result add at most 24,000 characters; rows past that get no `url` and the note says how many.
