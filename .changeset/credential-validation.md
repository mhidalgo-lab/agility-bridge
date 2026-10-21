---
'agility-bridge': minor
---

Stored Agility tokens are validated on save, on demand (`agility-bridge credential validate`), every
`AB_CREDENTIAL_REVALIDATION_HOURS` and after repeated refusals; new or changed instance addresses are probed without a
token before use. Clear messages separate a revoked token from a wrong instance address.
