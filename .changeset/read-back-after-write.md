---
"agility-bridge": patch
---

Bounded read-back after a write (P7-19): `update_status`, `assign_owners`, `move_to_sprint`, `update_fields`, `close_asset`, `reopen_asset` and `add_comment` read the item once after the change was sent and answer `readBack: confirmed`, `not_yet_visible` or `unknown`. It is never an error and never repeats the write. Declared costs of `add_comment`, `update_fields`, `move_to_sprint` and `reopen_asset` rose by 1 to 2 requests for that read.
