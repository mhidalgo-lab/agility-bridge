---
"agility-bridge": patch
---

Writes cost fewer storage round trips: the approval grant and denial reads run only where the approval page exists, and `kv.list` and `kv.deletePrefix` on SQL storage (D1 and SQLite) read a key range instead of scanning the table. `close_asset` counts open children in one request and `create_work_item` looks up the caller once. The write tools' declared costs now follow their measured worst case (`assign_owners` 18, `reopen_asset` 10, `create_work_item` 20, `update_status` 15, `add_comment` 18).
