---
"agility-bridge": minor
---

Write approvals (P7-28): an approval is now used up just before the change is sent, not when it is found, so a limiter refusal, a conflict or an audit outage no longer makes the person approve again. It stays single use: two concurrent calls on one approval send once.
