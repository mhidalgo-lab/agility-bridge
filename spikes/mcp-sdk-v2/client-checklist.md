# P0-07 owner checklist: real clients

What only the owner can run: each primary client against the spike, on this machine. No deploy and no Cloudflare
account are needed for any client that runs locally; the spike serves canned data and the bearer tokens are not secrets.
Record each result in [`RESULTS.md`](RESULTS.md) (client version, date) and copy verified cells into
[`docs/reference/client-compatibility.md`](../../docs/reference/client-compatibility.md).

## Start the spike

```sh
cd spikes/mcp-sdk-v2 && pnpm install
PORT=8787 pnpm node          # HTTP: http://127.0.0.1:8787/w/team/mcp (or /w/viewer/mcp)
```

- HTTP header: `Authorization: Bearer ab_spike_team` (or `ab_spike_viewer` for the viewer URL).
- stdio command: `node_modules/.bin/tsx src/stdio.ts` with the absolute path to `spikes/mcp-sdk-v2`, and the
  environment variable `AB_SPIKE_WORKSPACE=team` (or `viewer`) set in the client's MCP configuration.

## For each client, record

1. **Listed:** the `team` workspace shows `whoami`, `query_assets`, `get_work_item`, `add_comment`; `viewer` shows no
   `add_comment`.
2. **Era:** ask the agent to call `whoami`; the answer ends with `era=legacy` (2025) or `era=modern` (2026-07-28).
3. **Structured output:** ask for `query_assets` with `asset_type` `Story`; note whether the client shows the
   structured result or only text.
4. **Errors:** ask for `get_work_item` `B-99999`; note how `AB_NOT_FOUND` is shown.
5. **Approval:** ask for `add_comment` on `B-01001`. Note whether an approval prompt appears (elicitation) and whether
   the result says `approved via …` or `AB_APPROVAL_UNAVAILABLE`. Decline once to see `AB_APPROVAL_DECLINED`.
6. **Annotations:** does the client skip its own confirmation for read tools (`readOnlyHint`) or ask anyway?
7. **Tool-list change:** stop the server, restart it, and note whether the client picks up the tool list again without
   a restart.

## Clients

| Client | stdio | HTTP | Notes |
|---|---|---|---|
| GitHub Copilot in VS Code | ☑ 2026-10-20 | ☑ 2026-10-20 | 2026-07-28 on both; approve and decline work |
| GitHub Copilot in JetBrains | not tested (WSL) | ☑ 2026-10-20 | 2025 era; writes refused over HTTP as predicted |
| GitHub Copilot CLI | ☑ 1.0.87 | ☑ 1.0.87 | done 2026-10-20 |
| Claude Code | ☑ 2.1.304 | ☑ 2.1.304 | done 2026-10-20 |
| Claude Desktop | ☐ | — | `claude_desktop_config.json`; HTTP connectors need a public URL (P5-06) |
| Cursor | — | — | not tested (no subscription) |
| Windsurf / Devin Desktop | — | — | not tested (no subscription) |
| MCP Inspector (web UI, `--protocol-era modern`) | ☐ | ☐ | does the web UI elicit? |

claude.ai web and Claude mobile need a public HTTPS URL and are verified with OAuth in P5-06, not here.
