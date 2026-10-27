---
"agility-bridge": minor
---

Add the `portfolio` tool group: `list_portfolio_items` (epics with category, status, parent, estimates and child counts, filtered and paged) and `get_portfolio_tree` (an epic with its descendant epics and roll-ups of items, done items, open defects, estimate and done percentage; a depth, size, budget or permission cut is reported as `partial` and marks the roll-ups it touches `incomplete`). The stdio server serves the group by default.
