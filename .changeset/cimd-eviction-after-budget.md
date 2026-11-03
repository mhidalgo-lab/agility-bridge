---
"agility-bridge": patch
---

OAuth client metadata documents (P9-02): a stored client document is now evicted at the cap only after the per-address and per-deployment fetch budgets have passed and a valid document was fetched, so a caller with no budget left can no longer empty the cache of other clients' documents one request at a time. No setting or API changes.
