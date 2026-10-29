---
"agility-bridge": minor
---

Approval policy (P7-26): an owner can require the approval page for every write, per workspace (`writePolicy.approval: page_only`) or per grant (`rateLimit.writeApproval: page_only`). Under it a client that can elicit is never asked, so a client that accepts every question cannot approve. The default stays as it was.
