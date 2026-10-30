---
name: agility-workflows
description: How to answer questions about Digital.ai Agility (backlog, sprints, teams, work items, history) with the agility-bridge MCP tools. Use when the user asks about stories, defects, tasks, epics, sprints, velocity, owners or changes in Agility.
---

# Working with Agility through agility-bridge

The `agility` MCP server answers from the member's own Agility access token and sees only what that member and the
workspace's project scope allow. Prefer the typed tools; they are cheaper and safer than the generic ones.

| Question | Start with |
|---|---|
| What am I working on? | `list_my_work` |
| Find or open an item | `search_work_items`, then `get_work_item` (accepts a number such as `S-01234`) |
| Sprints, teams, capacity | `list_sprints`, `get_sprint`, `list_teams`, `get_team`, `get_velocity` |
| Who is who | `list_members` |
| What changed, and when | `get_asset_history`, `list_recent_changes` |
| Epics and portfolio trees | `list_portfolio_items`, `get_portfolio_tree` |
| Discussion and files | `get_conversations`, `list_attachments` |
| Anything else | `list_asset_types` and `describe_asset_type` first, then `query_assets` or `get_assets` |
| Health reports (opt-in group) | `sprint_health`, `standup_summary`, `release_readiness`, `defect_triage`, `work_item_quality` |

## Habits that save requests

- Ask for the fields you need; do not page through everything. Results say when they were cut and how to continue
  (`next`); follow that rather than repeating the same call.
- A name that matches several things returns candidates: show them, or pick by the identifier (`Scope:1234`,
  `Team:5678`), never by guessing.
- Results that fall outside the workspace's projects are dropped and counted (`hiddenOutsideScope`); say so if it
  matters to the answer.
- Every asset row carries a link that opens it in Agility: give it when you name an item.
- After the server is upgraded, tool lists can be stale: reconnect the server (`/mcp`) if a tool or argument is missing.

## Writes

Write tools (comments, status, effort, owners, sprint moves, create, update, close) exist only when the person enabled
them, and each change needs their approval. Always use the dry run first, show what would change, and never retry a
write that failed or was refused.
