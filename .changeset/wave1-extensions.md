---
"agility-bridge": minor
---

Wave-1 write extensions (P7-17), as arguments of existing tools: `move_to_sprint` takes `to_backlog: true` to take an item out of its sprint; `log_effort` takes `member` to log for another member who already owns the item (otherwise refused before any approval; the approval names the member); `update_fields` takes `todo` for the remaining hours of a task or test. Each shows old and new in the approval. The request shapes are unverified until the sandbox run.
