---
"agility-bridge": patch
---

`defect_triage` shows priority and severity again on projects with more than 50 open defects: the read of those fields used a
filter bounded at 50 values and failed silently ("could not be read"). Found by the live check of P6-57.
