---
"agility-bridge": minor
---

Workspace-enabled writable custom attributes (P7-20): an owner lists the `Custom_` attributes an agent may write per workspace (panel, `PATCH /workspaces/{id}` with `writePolicy.customFields`, or `AB_WRITE_CUSTOM_FIELDS` for stdio), and `create_work_item` and `update_fields` accept them in a `custom` argument as text, long text or a number, checked against the instance's own attribute. Anything not on the list is refused before any request; the approval shows each value old to new; no tool description names an instance attribute. The request shape is unverified until the sandbox run.
