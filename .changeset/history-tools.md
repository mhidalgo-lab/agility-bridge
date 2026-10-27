---
"agility-bridge": minor
---

New tools in the `history` group: `get_asset_history` (what changed on one asset in a bounded window, from the authoritative Agility history, one row per changed field with who and when) and `list_recent_changes` (work items changed in a bounded window in a project, a team or the workspace, newest change first). Both validate the window and the row limit before any request; the activity stream is not used.
