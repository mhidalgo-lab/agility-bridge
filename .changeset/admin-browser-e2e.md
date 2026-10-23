---
'agility-bridge': patch
---

Fixes found by running the admin panel in a real browser (P4-08): a table that scrolls sideways on a narrow screen can now
be reached with the keyboard (it is a focusable, named region), and an admin API request that sends an empty body as JSON
is answered `400 bad_request` instead of `500 internal error`.
