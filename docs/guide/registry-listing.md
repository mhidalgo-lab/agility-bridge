# Listing agility-bridge in the MCP Registry and plugin marketplaces

> For maintainers. Everything here is **prepared and checked offline**; publishing is a step only the owner takes, with
> their own accounts. Nothing in this repository publishes to a registry or marketplace by itself.

## What is in the repository

| File | What it is | Kept in step by |
|---|---|---|
| `server.json` | The [MCP Registry](https://registry.modelcontextprotocol.io) entry: the npm package, stdio, the settings (`AB_AGILITY_TOKEN` marked secret) | `release.ts sync-version` (versions), a test (name, settings, secrets) |
| `apps/cli/package.json` `mcpName` | The registry name `io.github.mhidalgo-lab/agility-bridge`, which the registry checks against the package on npm | a test compares it with `server.json` |
| `plugins/agility-bridge/` | The Claude Code plugin: manifest, `.mcp.json`, four commands, two skills | `release.ts sync-version` (manifest version, pinned package), a test of every file |
| `.claude-plugin/marketplace.json` | Makes the repository a Claude Code marketplace: `/plugin marketplace add mhidalgo-lab/agility-bridge` | a test (the source exists) |

`pnpm lint` fails when the CLI version, `server.json`, the plugin manifest or the plugin's pinned package disagree; run
`node scripts/release.ts sync-version` to fix them (the release workflow's *Version Packages* PR does this itself).

## Publishing to the MCP Registry (owner)

1. Release the npm package first: the registry validates that the version named in `server.json` exists on npm and
   that the package's `mcpName` matches.
2. Install `mcp-publisher` (see the registry's quickstart) and sign in with the GitHub account that owns
   `mhidalgo-lab` (the `io.github.mhidalgo-lab/` namespace is proven by that login).
3. From the repository root: `mcp-publisher validate`, then `mcp-publisher publish`.
4. Check the listing: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=agility-bridge"`.
5. Repeat for each release (the registry takes a new version, not an edit of an old one).

Not done in this batch: the validation against the registry's current schema (the test only checks the fields we
depend on, offline) and the publish itself.

## Listing the plugin (owner)

- **Straight from this repository** (works as soon as the files are on `main`): people run
  `/plugin marketplace add mhidalgo-lab/agility-bridge`, then `/plugin install agility-bridge@agility-bridge`.
  Run `claude plugin validate plugins/agility-bridge` and `claude plugin validate .` once with a real Claude Code first.
- **Anthropic's directory or another marketplace**: submitted by the owner through that marketplace's own process. The
  plugin manifest has the fields such a listing reads from `plugin.json` (`homepage`, `repository`, `license`); an
  `icon`, a `supportUrl` and a `privacyPolicyUrl` are not set and are the owner's to choose.

## Verification still to record

Each of these needs the real client and its version, and is recorded in the
[compatibility matrix](../reference/client-compatibility.md) when done:

- VS Code: the `vscode:mcp/install` link and the web redirect (the token prompt appears; the server lists its tools).
- Cursor: the `cursor://` link (the dialog shows the entry; the placeholder is replaced).
- Claude Code: the plugin installs from the marketplace file, prompts for its two settings, `/mcp` shows the server,
  and each command runs.
- `claude mcp add …` from `agility-bridge client-config claude-code`.
- The MCP Registry entry validates and the listing appears.

Clients cache tool lists (L-027): after any of these, reconnect the server before judging what it offers.
