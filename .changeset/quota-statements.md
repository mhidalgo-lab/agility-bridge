---
"agility-bridge": patch
---

Quota (P8-39): metadata requests (`meta.v1`) are no longer counted against `AB_QUOTA_DAILY` and `AB_QUOTA_MONTHLY` (they are still refused once a period is used up), and a request now adds to the day and the month counter in one storage statement (two D1 statements a request instead of three).
