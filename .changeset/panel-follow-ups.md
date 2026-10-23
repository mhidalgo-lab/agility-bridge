---
'agility-bridge': minor
---

Panel follow-ups (P4-15): a disabled user can be enabled again (`POST /api/admin/v1/users/{id}/enable`, `agility-bridge user
enable`, an Enable button on the user's page: owners for anyone with a recent sign-in for owners and admins, admins for members);
`GET /api/admin/v1/tokens` and a Device tokens page list every device token (prefix, label, dates and grant, never a hash), filtered
by person or grant and paged by cursor, with revoke; and an instance's number prefixes are validated on every path and editable
in the panel (`Type=PREFIX`, one per line). Stored prefixes are not applied to number lookups yet (P4-30).
