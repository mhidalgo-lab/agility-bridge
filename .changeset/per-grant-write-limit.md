---
"agility-bridge": minor
---

A per-grant write limit (P7-15): an owner (with a recent sign-in) can give a grant its own writes per hour, in the panel's grant form or as `rateLimit.writesPerHour` in the admin API. The write limiter uses the lower of it and `AB_WRITE_RATE_PER_GRANT_HOURLY`, a value above the server's is refused, and the change is audited with the previous value.
