---
"agility-bridge": patch
---

`get_sprint`: burndown history requests are sent up to three at a time, the first two item pages share one request, and
each history point is compiled once.
