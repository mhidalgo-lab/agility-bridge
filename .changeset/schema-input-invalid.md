---
"agility-bridge": patch
---

A tool argument the input schema refuses (below the minimum, outside an enum, missing, wrong type) is now an
`AB_INPUT_INVALID` tool error with the argument path and a hint, like every other refused input.
