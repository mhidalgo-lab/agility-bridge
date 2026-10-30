# Managing a server from the command line

> For `agility-bridge serve` (v0.2). Every command and option: [CLI reference](../reference/cli.md).

The management commands change the same things as the [admin API](../reference/admin-api.md) — users, Agility
instances, credentials, workspaces, grants, device tokens — with the same validation, the same owner/admin rules and
the same [audit log](audit-log.md). They print JSON on stdout (pipe it to `jq`) and messages on stderr.

## Local or remote

- **Local** (default): the commands open the server's database directly (`AB_DATA_DIR` or `AB_DB_PATH`, and the master
  key `AB_MASTER_KEY_FILE`), run the admin API in process and act as the break-glass owner. Run them on the server
  host, as the user that runs the server. Audit rows say `via: cli`.
- **Remote**: set `AB_ADMIN_URL=https://mcp.example.com` and the admin token (`AB_ADMIN_TOKEN_FILE`, or you are
  prompted for it). The commands call the server's admin API over HTTPS and never follow redirects. Audit rows say
  `via: api`.

Secrets are never command-line arguments: they would show in process listings and shell history. An Agility token
comes from `--from-file <path>` (a `0600` file), `AB_AGILITY_TOKEN`, standard input, or a hidden prompt. Any option that
looks like a secret (`--token`, `--password`, …) is refused.

## First setup

After [installing](self-hosting.md#install-node) (`agility-bridge init` wrote the master key), on the server host:

<!-- walkthrough: 2 -->
```sh
export AB_MASTER_KEY_FILE=~/.config/agility-bridge/master.key
agility-bridge instance add "Main" https://www7.v1host.com/YourInstance
agility-bridge credential add --instance <instance-id> --label "Service member" --from-file ./service.token
agility-bridge user add ann@example.com --name "Ann"
agility-bridge workspace add team-mobile --name "Mobile team" --instance <instance-id> --project Scope:1001 --children --default-credential <credential-id>
agility-bridge grant add --workspace <workspace-id> --user <user-id> --tools whoami,search_work_items,get_work_item
agility-bridge token issue <grant-id> --label "Ann's laptop"
```

Each command prints the new record as JSON; use its `id` in the next command. `credential add` validates the token
against Agility and shows the member behind it. `token issue` prints the device token once: put it into the MCP client
of that device ([devices](multi-device.md)) at `https://<server>/w/team-mobile/mcp`. Keep the master key away from the
data directory and back it up separately ([secrets](secrets.md)).

Credentials added here are **shared** (a service member's token, used read-only). A member's own token is personal:
only they can store it (in the admin panel under *My access*, [admin panel](admin-panel.md#my-access-every-role)); nobody can store it for them.

## Everyday commands

| What | Command |
|---|---|
| List users, instances, credentials, workspaces, grants | `agility-bridge user list`, `agility-bridge instance list`, `agility-bridge credential list`, `agility-bridge workspace list`, `agility-bridge grant list --workspace <id>` |
| Show one workspace | `agility-bridge workspace show <workspace-id>` |
| Change a workspace | `agility-bridge workspace set <workspace-id> --name "New name" --max-rows 50` |
| Give someone a role | `agility-bridge user set-role <user-id> admin` (owners only) |
| Disable a user | `agility-bridge user disable <user-id>` |
| Enable a disabled user | `agility-bridge user enable <user-id>` |
| Move a user to another sign-in provider | `agility-bridge user unbind <user-id> --confirm <email>` (owners; [what it means](identity-providers.md#moving-a-user-to-another-provider)) |
| Sign a user out everywhere | `agility-bridge user end-sessions <user-id>` ([browser sessions](admin-access.md)) |
| Lost device | `agility-bridge token list <grant-id>`, then `agility-bridge token revoke <token-id>` |
| Someone leaves | `agility-bridge grant revoke <grant-id>` (all their devices stop) |
| Replace a service token | `agility-bridge credential replace <credential-id> --from-file ./new.token` |
| Check a credential now | `agility-bridge credential validate <credential-id>` |
| Retire a credential | `agility-bridge credential revoke <credential-id>`, later `agility-bridge credential delete <credential-id>` |
| Remove a workspace | `agility-bridge workspace disable <workspace-id>` or `agility-bridge workspace delete <workspace-id>` |
| Remove an instance | `agility-bridge instance delete <instance-id>` (only when unused) |
| Move an instance to a new address | `agility-bridge instance retarget <instance-id> https://new.example.com/Instance` (owners; revokes its credentials and grants) |
| Remove a grant | `agility-bridge grant delete <grant-id>` |
| Read the audit log | `agility-bridge audit tail --limit 50 --kind auth` |
| Create the first owner (a single-use sign-in link; needs [sign-in providers](identity-providers.md)) | `agility-bridge setup-link --ttl-minutes 30` |
| Back up while the server runs (local only) | `agility-bridge backup /backups/agility-bridge-2026-10-21.db` |
| Restore (server stopped) | `agility-bridge restore /backups/agility-bridge-2026-10-21.db /srv/agility-bridge/restored.db` |
| Check this setup (read-only; see [troubleshooting](troubleshooting.md)) | `agility-bridge doctor` (`--check-token` sends one request with your token, `--offline` none, `--fix` only repairs file modes it lists) |
| Keep a token or the master key in the OS keychain ([secrets](secrets.md#keeping-secrets-in-the-os-keychain)) | `agility-bridge keychain set agility-token --for-url https://www7.v1host.com/YourInstance`, `agility-bridge keychain bind agility-token --for-url https://www7.v1host.com/YourInstance` (binds an older entry, or confirms a new address), `agility-bridge keychain status --name agility-token`, `agility-bridge keychain delete agility-token`, `agility-bridge init --keychain master` |
| Back up or move the configuration ([guide](migrating-config.md)) | `agility-bridge config export --out staging.json` (add `--with-tokens` to seal tokens with a passphrase), then `agility-bridge config import staging.json` (a dry run) and `agility-bridge config import staging.json --apply` |
| Print the setup snippet or install link for a client ([clients](clients.md)) | `agility-bridge client-config vscode --url https://www7.v1host.com/YourInstance`, `agility-bridge client-config claude-code --keychain agility-token`, `agility-bridge client-config vscode --link` |
| A new break-glass admin token | `agility-bridge admin-token` (put it in a `0600` file for `AB_ADMIN_TOKEN_FILE`) |
| Master-key rotation (local only) | `agility-bridge keys status`, `agility-bridge keys rotate --reason "yearly"`, `agility-bridge keys retire 1 --reason "rotation done"` |

Changes take effect for new requests at once on the server that made them, and within the access cache (at most 60 s,
`AB_ACCESS_CACHE_TTL`) on other server processes.

Exit codes: `0` done, `1` refused or failed (the reason is on stderr), `2` wrong usage. Each command has `--help`.
