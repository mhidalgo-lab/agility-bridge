---
"agility-bridge": patch
---

The panel's users list is paged on the server (`GET /users` accepts `limit`, `offset` and `ids`) and the audit page loads at
most 100 users for its filter, so both screens cost the same at a few hundred users.
