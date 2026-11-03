# Upgrading

> The procedure for every deployment mode. Read the release notes of every version you skip, in particular *Breaking*
> and *Deprecated*; the guarantees are in the [versioning policy](versioning.md).

## Reconnect your clients (every upgrade)

**MCP clients cache the tool list** (L-027). After an upgrade, restart or reconnect the server in each client before you
expect new tools, new arguments or new output fields: restart the MCP server in VS Code, JetBrains and Claude Code,
restart Claude Desktop, and remove and re-add the connector in claude.ai if its list does not refresh
([client setup](clients.md)). A client that keeps the old list calls tools with the old arguments: deprecated ones still
work during their window, removed ones fail with a validation error.

## Local stdio (`npx`)

`npx -y agility-bridge` fetches the latest version when its cache expires. To upgrade at once, pin the version in the
client's configuration (`agility-bridge@<version>`) or run `npm install -g agility-bridge@latest`, then restart the
server in the client. `agility-bridge doctor` afterwards checks the configuration and the client files. Nothing is stored,
so there is nothing to migrate.

## Self-hosted server (Node or Docker)

1. **Back up**: `agility-bridge backup <file>`. The master key stays where it is, away from the data. `config export`
   also keeps a readable record of the settings ([moving or backing up](migrating-config.md)).
2. Read the release notes: *Breaking*, renamed `AB_*` variables and CLI flags. Unknown `AB_` settings stop the server at
   start, so a typo or a removed setting is caught immediately.
3. Install the new version (`npm install -g agility-bridge@<version>`) or pull the image
   (`ghcr.io/mhidalgo-lab/agility-bridge:<X.Y.Z>`; pin a version or digest in production, not `latest`).
   [Verify it](verify-release.md) first.
4. Restart. **Storage migrations run at start**, all or nothing and forward only ([storage](../dev/storage.md)). A
   database written by a newer version is refused (`MigrationError`), so a rollback needs the backup from step 1.
5. Run `agility-bridge doctor`, then reconnect the clients. Device tokens and OAuth connections keep working.

## Cloudflare Worker

1. Back up the D1 database (`wrangler d1 export <database>`) and read the release notes.
2. From a checkout of the new version, run `pnpm cf:setup --name <worker>` again: a second run only redeploys and keeps
   the secrets ([Cloudflare deployment](cloudflare-deploy.md)). The Worker migrates its database at the first request.
3. Open `/health`, then reconnect the clients.

## Rolling back

Redeploy the older version and, if the new one migrated the database, restore the backup taken before the upgrade
(a database newer than the binary is refused). Configuration exported before the upgrade can be re-imported with
`config import`. If rollback is not acceptable, stay on the new version and wait for a patch.

## When something breaks after an upgrade

[Troubleshooting](troubleshooting.md) lists the usual causes; a cached tool list is the first. Report a regression with
the error code, the client and its version, and the agility-bridge version. For a vulnerability use
[SECURITY.md](../../SECURITY.md), never a public issue.
