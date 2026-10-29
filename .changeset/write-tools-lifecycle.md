---
"agility-bridge": minor
---

Lifecycle write tools (P7-06): `close_asset` and `reopen_asset`, `destructive` and separately enabled in the opt-in `writes` group. Each acts on one work item, sends the type's own Agility operation (chosen from its metadata) once after approval, refuses a close while the item has open children, and treats an already-closed or already-open item as a no-op. The operation names are verified against a sandbox in P7-07.
