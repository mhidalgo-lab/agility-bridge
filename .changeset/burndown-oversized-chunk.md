---
"agility-bridge": patch
---

`get_sprint`: a burndown history request that exceeds the response limit now leaves out its points (named in `notes`,
`partial`) instead of failing the whole call; large page sizes send fewer queries per request.
