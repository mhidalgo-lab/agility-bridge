---
"agility-bridge": patch
---

Phase 8 review fixes (P8-12) for the remote hosts: the shared tier of the query cache never serves an answer older than one TTL, and a read-only grant in a workspace where others write uses the cache; a refused quota no longer spends a call-budget unit; on Workers the quota counters and the cache's shared-tier store finish after the response; MCP Tasks validate the call and cap creations per grant at creation, return a finished result only while the grant still has the tool and scope, report their real remaining life, fail (not rerun) a report that does not fit one request or is too large to keep, and honour a cancel that races the result; self-monitoring samples spans of unauthenticated requests (30 a minute) and the public catalogue no longer advertises the Tasks extension.
