---
'agility-bridge': patch
---

Phase 3 review fixes: `keys retire` (and `POST /keys/{version}/retire`) refuses a version this database never used or a
future one, and keeps the operator's reason in the audit row; `AB_INSTANCE_PRIVATE_ADDRESSES=refuse` also refuses
IPv4 embedded in IPv6 (IPv4-compatible, SIIT, NAT64, 6to4), site-local IPv6 and the special and documentation IPv4
ranges.
