# Quickstart: a remote server, a signed-in owner and a connected client

> From nothing to a team server that you manage in the browser and an MCP client that reaches it. Two hosts, one path:
> **Node** (`agility-bridge serve` behind HTTPS) or **Cloudflare** (a Worker on D1). After the host is up, the steps are
> the same. For one person on one machine use the [local quickstart](quickstart-local.md) instead. Where to go next:
> the [admin guide](admin-guide.md).
>
> The commands marked in this page run in CI (`scripts/test/docs.test.ts`, L-133) against the CLI built from this
> repository, and the longer walkthrough in [self-hosting](self-hosting.md) runs end to end on a fresh machine. A
> sign-in with a real Google, GitHub or OIDC application is an owner step that has not been run yet
> ([pending decisions](../pending-decisions/phase-4.md)); everything else here is tested against local fake providers and
> a real browser (P4-08).

## What you need

- **An address with HTTPS** that browsers and MCP clients reach, for example `https://mcp.example.com`. For a first try on
  your own machine `http://localhost:8787` also works for the panel and for `serve`.
- **One sign-in provider**: Google, GitHub, Cloudflare Access or any OpenID Connect provider. You register agility-bridge
  there and get a client id and secret ([create the applications](identity-providers.md#create-the-applications)). The
  redirect address is `<public URL>/auth/callback/<provider>`, for example `https://mcp.example.com/auth/callback/google`.
- **An Agility access token** for a service member or for yourself (Agility, profile menu, *Applications*, *Add
  Application*, copy the token once) and the address of your instance (`https://www7.v1host.com/YourInstance`). Hosted
  instances and any instance on the public internet work on both hosts; an instance on a private network needs `serve`
  ([which instances a Worker can reach](cloudflare-deploy.md#which-agility-instances-a-worker-can-reach)).
- **Node 24** (`node --version`) for the command line.

The terms: an **instance** is an Agility site; a **credential** is an Agility token stored encrypted; a **workspace** is
one MCP address (`/w/<slug>/mcp`) with its projects and tools; a **grant** lets a person or a service use a workspace;
a **device token** is what one device presents. See the [access model](access-model.md).

## 1. Start the server

### A. Node, behind HTTPS

Create the two secrets once and keep them away from the data directory ([secrets](secrets.md)):

```sh
npm install -g agility-bridge
agility-bridge init
agility-bridge admin-token > ~/.config/agility-bridge/admin.token
chmod 600 ~/.config/agility-bridge/admin.token
```

Start the server with the public address and your provider's settings (Google here; the same names for the others are in
[identity providers](identity-providers.md#settings)):

```sh
export AB_PUBLIC_URL=https://mcp.example.com
export AB_MASTER_KEY_FILE=~/.config/agility-bridge/master.key
export AB_ADMIN_TOKEN_FILE=~/.config/agility-bridge/admin.token
export AB_GOOGLE_CLIENT_ID=<client id from Google>
export AB_GOOGLE_CLIENT_SECRET_FILE=~/.config/agility-bridge/google.secret   # a 0600 file holding only the secret
export AB_TRUSTED_PROXY_HOPS=1   # exactly one proxy in front
agility-bridge serve
```

It listens on `127.0.0.1:8787`. Put a reverse proxy with a certificate in front (Caddy, nginx or a load balancer:
[behind a reverse proxy](self-hosting.md#behind-a-reverse-proxy-https), or [Docker with Caddy](self-hosting.md#with-docker-compose-and-caddy)).
For a systemd unit see [self-hosting](self-hosting.md#run-the-server). Check it:

```sh
curl -s https://mcp.example.com/health
```

Without any provider setting the `/auth/*` routes answer `404`: nobody can sign in, so the browser panel is unusable
until one provider is configured.

### B. Cloudflare

You need a Cloudflare account (the Free plan works), `wrangler` logged in
(`pnpm --filter @agility-bridge/worker exec wrangler login`) and a checkout of this repository with `pnpm install` done. One
command creates the database, deploys, generates the master key and admin token, and sets up sign-in
([Cloudflare deploy](cloudflare-deploy.md)):

```sh
pnpm cf:setup --name agility-bridge --domain mcp.example.com --secrets-file ~/.config/agility-bridge/prod.secrets --sign-in
```

`--sign-in` asks which providers you use and each client id and secret (read without echo; the secrets go to
`wrangler secret put` on stdin, never to a file), and the allowlist policy: leave it empty to add every person by hand,
which is the safe default ([who may sign in](identity-providers.md#let-people-in)). At the end it prints the
**callback addresses to register at each provider**; do that now if you have not. `--dry-run` shows the plan and asks
nothing. Without `--domain` the Worker is at a `workers.dev` address learnt from the first deploy; give a domain first if
you can, because the registrations break when the address changes. A Free-plan Worker's first request after a deploy can be
slow ([limits](cloudflare-limits.md#measured-cost)). Check it:

```sh
curl -s https://mcp.example.com/health
```

The secrets file holds the master key and the admin token: back it up away from the data
([secrets](secrets.md)). Put the admin token into its own `0600` file for the commands below:

```sh
(umask 077; grep '^AB_ADMIN_TOKEN=' ~/.config/agility-bridge/prod.secrets | cut -d= -f2- > ~/.config/agility-bridge/prod.admin-token)
```

## 2. Become the first owner

An owner is needed before anything can be delegated. Make a single-use **setup link** with the admin token (the
break-glass owner, for this step and for automation, not for daily use):

<!-- doc-test -->
```sh
npx -y agility-bridge setup-link --help
```

On Node, on the machine that holds the database, with the same environment as the server:

```sh
agility-bridge setup-link --ttl-minutes 30
```

Against a remote server (and on Cloudflare), from any machine:

```sh
export AB_ADMIN_URL=https://mcp.example.com
export AB_ADMIN_TOKEN_FILE=~/.config/agility-bridge/admin.token   # prod.admin-token on Cloudflare
agility-bridge setup-link --ttl-minutes 30
```

It prints `{"id": …, "url": "https://mcp.example.com/auth/setup#ab_setup_…", "expiresAt": …}`. Open the `url` in your
browser, choose the provider and sign in. You land in the panel at `/admin` as an **owner**.

- The link works once, expires after the time you chose, and always means *owner*: share it with nobody, and keep it out of
  chats and tickets. If a sign-in through it is refused, the link is used up; make another.
- The secret sits in the address fragment (`#…`), which browsers never send to a server, so it is in no log.
- If the sign-in fails, see [troubleshooting](admin-guide.md#troubleshooting): the audit log has the reason
  (`agility-bridge audit tail --kind auth`).

## 3. Set up a workspace

In the panel (menu on the left, or the top on a phone), as the owner. The same steps work from the command line
([CLI first setup](cli.md#first-setup)) and from the [admin API](../reference/admin-api.md).

```sh
agility-bridge instance add --help
agility-bridge credential add --help
agility-bridge workspace add --help
agility-bridge grant add --help
```

<!-- doc-test -->
```sh
npx -y agility-bridge token issue --help
```

1. **Instances, Add**: a name and the instance address (`https://www7.v1host.com/YourInstance`). The server checks the
   address with a request that carries no token. For an on-premises instance with a private certificate authority see
   [self-hosting](self-hosting.md#on-premises-agility-with-a-private-ca).
2. **Credentials, Add**: your Agility token, once, in a password field. It is encrypted at once and never shown again; the
   page keeps only its last four characters. A *shared* credential (a service member's token) is read-only for everyone who
   uses it; a *personal* one acts as its person in Agility, and each person adds their own under *My access* later. Use
   *Check now* to see who the token belongs to and which projects it reaches.
3. **Workspaces, New**: choose the instance, then a short name (it becomes `/w/<name>/mcp`), the Agility projects it may
   serve (`Scope:1001`, comma separated), and the default credential. Tools default to every read tool; leave limits blank
   for the server defaults.
4. **Users, Add** a teammate by email (the role `member`). They sign in with the same provider and the same email
   address. To let a whole domain in without adding people one by one, use an allowlist
   ([let people in](identity-providers.md#let-people-in)).
5. **Grants, New**: choose the workspace and the person (or a named service), the credential, and optionally narrower
   tools, projects, a rate and an expiry. A grant can only narrow its workspace.
6. On the grant's page, **New device token**, with a label such as `Ann's laptop`. The token is shown **once**, on that page.
   Copy it now: the server keeps only its hash. Lost it? Revoke it and make another.

## 4. Connect an MCP client

On the grant's page (or **My access**, then the grant, for a member) choose **Connect a client**. It shows the workspace's
address, `https://mcp.example.com/w/<name>/mcp`, and a copy-paste configuration for each client: GitHub Copilot in VS Code,
in JetBrains and the Copilot CLI, Claude Code, Cursor, Windsurf and the MCP Inspector
([the snippets](clients.md#remote-server-device-token)). Most read the token from a password prompt or from the
`AGILITY_BRIDGE_TOKEN` environment variable so it never lands in a file you share. For example Claude Code:

```sh
read -rs AGILITY_BRIDGE_TOKEN   # paste the token, press Enter: nothing is echoed or kept in history
export AGILITY_BRIDGE_TOKEN
claude mcp add --transport http --scope user agility-my-team https://mcp.example.com/w/my-team/mcp \
  --header "Authorization: Bearer $AGILITY_BRIDGE_TOKEN"
```

Check the connection from the command line (the answer lists the tools the grant may use):

```sh
curl -s https://mcp.example.com/w/my-team/mcp -H "Authorization: Bearer $AGILITY_BRIDGE_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then ask your assistant "who am I in Agility?" (the `whoami` tool). claude.ai on the web, Claude Desktop connectors and Claude
mobile need OAuth, which is a later phase; they have no snippet yet.

## 5. What next

- A teammate signs in at `https://mcp.example.com/admin`, opens **My access**, adds their own Agility token, and issues
  device tokens for their devices ([member self-service](admin-panel.md#my-access-every-role)).
- Someone loses a laptop: **Device tokens**, find it, **Revoke**. Someone leaves: **Users**, **Disable**.
- Turn on the daily tasks, the role rules, sessions, the audit log and usage: the [admin guide](admin-guide.md).
- Before real use, run the sign-in once against your real provider and check the audit rows, as listed in the
  [pending decisions](../pending-decisions/phase-4.md).
