---
"agility-bridge": patch
---

The admin panel now says which tools the server's own per-call request budget hides (for example every report on Workers Free, 45 requests) on a workspace or grant that sets no `callBudget` (P6-58). The admin API gains a read-only `GET /limits` with the server's default and ceiling.
