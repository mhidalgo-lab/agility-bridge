---
"agility-bridge": minor
---

Per-grant Agility request quotas (P8-09): `AB_QUOTA_DAILY` and `AB_QUOTA_MONTHLY` cap the requests one grant may cause per UTC day and month (off unless set). A read over its quota is refused with `AB_LIMIT_QUOTA` before anything is asked of Agility; retries and query-cache hits are not counted; a counter outage fails open. Usage shows in `whoami`, the new `GET /grants/{id}/usage` admin route and the grant page of the panel, with a warning at 80%. See docs/guide/query-limits.md.
