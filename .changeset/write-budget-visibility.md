---
"agility-bridge": minor
---

Show the remaining write budget (P7-16): `whoami` and every write tool's dry run report the caller's own grant's writes used, left and the end of the hour (and that the deployment is spent), and an owner or administrator sees the server-wide use on the panel overview and a grant's use on its page (`GET /api/admin/v1/writes/budget`, `GET /api/admin/v1/grants/{id}/write-budget`). Reading takes no unit and a store that cannot be read shows "unknown", never "unlimited".
