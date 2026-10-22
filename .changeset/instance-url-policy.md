---
'agility-bridge': minor
---

`agility-bridge serve` and the management commands refuse plain-HTTP instance URLs (also `http://127.0.0.1`) unless
`AB_ALLOW_HTTP_INSTANCES=on`, meant for tests and the local synthetic Agility. New `AB_INSTANCE_PRIVATE_ADDRESSES=refuse`
accepts only instances at public addresses, checked when an instance is added or retargeted and at every connection.
The stdio mode is unchanged.
