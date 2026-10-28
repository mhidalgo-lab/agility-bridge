---
"agility-bridge": patch
---

`get_work_item` renames its `minimal_output` argument to `skip_related` (it leaves out children, links and comments), so `minimal_output` means one thing everywhere (identity columns only). Small internal helpers were deduplicated.
