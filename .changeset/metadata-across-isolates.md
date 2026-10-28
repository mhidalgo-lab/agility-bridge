---
"agility-bridge": patch
---

The Worker keeps parsed asset-type metadata in D1 so a new isolate reads it instead of asking Agility for every type again (fewer upstream requests on a cold call), and prompt argument schemas are converted at module load.
