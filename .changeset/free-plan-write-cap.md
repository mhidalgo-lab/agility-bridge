---
"agility-bridge": patch
---

Workers Free plan (P7-30): the deployment-wide write cap defaults to 60 an hour there (200 elsewhere) and a larger `AB_WRITE_RATE_DEPLOYMENT_HOURLY` stops the Worker at start, so write traffic alone cannot exceed the plan's D1 row budget. The grant and denial of an approval are read with one statement.
