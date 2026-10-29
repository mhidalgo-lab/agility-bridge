---
"agility-bridge": minor
---

Approval request limits (P7-27): a connection can ask for at most 30 approvals an hour (`AB_LIMIT_RATE`, scope `approval_requests`; nobody is asked past it), and a person with 20 approvals waiting on the page gets a refusal for the next one instead of losing the oldest.
