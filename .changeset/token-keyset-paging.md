---
"agility-bridge": patch
---

Device token lists read one page from storage by `(created_at, id)` instead of every token (new migration 0002, an index
on `access_tokens`); the admin API and its cursor format are unchanged.
