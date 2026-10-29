---
"agility-bridge": minor
---

Out-of-band approval page (P7-02): a write that the client cannot ask the person about now answers `AB_WRITE_APPROVAL_PENDING` with a link to `/admin/approve/<id>` in the signed-in panel, where the person who made the request reviews the exact change and approves or declines it; the agent then repeats the call. Single use, bound to the change and the workspace, short expiry, CSRF and a recent sign-in to approve. Only with `AB_WRITE_TOOLS=on` and sign-in configured; no write tool ships yet.
