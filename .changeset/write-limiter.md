---
"agility-bridge": minor
---

Write limiter (P7-03): every write takes one unit from a per-grant and a deployment-wide hourly counter (defaults 20 and 200, `AB_WRITE_RATE_PER_GRANT_HOURLY`, `AB_WRITE_RATE_DEPLOYMENT_HOURLY`). The counters live in the shared storage, so they hold across Workers isolates and replicas, and the limiter fails closed (`AB_WRITE_LIMIT_UNAVAILABLE`). A refused write makes no upstream call. No write tool ships yet.
