---
"agility-bridge": patch
---

`get_work_item` renames its `minimal_output` argument to `skip_related` (it leaves out children, links and comments), so `minimal_output` means one thing everywhere (identity columns only). The old name is **deprecated**: it still works on `get_work_item` for one release (mapped to `skip_related`, with a deprecation note in the result, not advertised in `tools/list`) and will be removed in 0.7.0. Small internal helpers were deduplicated.
