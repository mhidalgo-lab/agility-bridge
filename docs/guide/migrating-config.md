# Moving or backing up the configuration

> `agility-bridge config export` and `config import` (v0.8). For a deployment run with `agility-bridge serve` or on
> Cloudflare; the local stdio mode keeps its configuration in your client. Every option: [CLI reference](../reference/cli.md).

Use them to set up a second deployment like the first (staging, then production), to keep a readable record of how a
deployment is set up, or to rebuild after a mistake. Run them the way you run the other
[management commands](cli.md): on the server host against its database, or with `AB_ADMIN_URL` and the admin token
against a running server. Only the holder of the database and master key or of the admin token can do either: there is
no member or admin path.

## What moves, and what does not

| Moves | Does not move |
|---|---|
| Instances: label, address, number prefixes | The instance's TLS file paths (they are paths on one machine) |
| Shared credentials: name and last four characters of the token | Their tokens, unless you export with a passphrase (below) |
| Workspaces: projects, tools, asset types, limits, write policy, credential source, default credential | Users, their roles and sign-in identities |
| Service grants (a label, no person) | People's grants, personal credentials, device tokens, OAuth devices, sessions |
| | The audit log; disabled, revoked and expired items |

People are left out on purpose: who someone is belongs to the target's own sign-in, and a personal credential must never
be assigned to anyone else. Add people and their grants on the target as usual.

## Export

```sh
agility-bridge config export --out staging.json        # no tokens: safe to keep in a repository
```

The file is JSON, readable, and holds no secret. It is created with mode `0600` and never overwrites a file. Without
`--out` it goes to standard output (only for the no-token form).

To move the shared credentials' tokens too, seal them with a passphrase:

```sh
export AB_CONFIG_PASSPHRASE='…at least 12 characters…'   # or --passphrase-file, standard input, or the prompt
agility-bridge config export --with-tokens --out staging.json
```

This works on the local database only (it needs the master key to open the stored tokens) and writes an audit row with
counts, never a value. The tokens are encrypted with AES-256-GCM under a key derived from your passphrase with
PBKDF2-HMAC-SHA-256 (600,000 iterations, a fresh salt and IV each time); the file's header is authenticated, so editing
it breaks the open. **Keep the file and the passphrase apart.** The passphrase is never a command-line flag.

## Import

```sh
agility-bridge config import staging.json              # a dry run: shows the plan, writes nothing
agility-bridge config import staging.json --apply      # makes the changes
```

Import is **additive**: it creates what is missing and never changes or deletes what is there. Matching is by instance
address, shared-credential label and workspace slug; anything that matches is reported as `exists` and left alone,
even when the file says something different (so an import cannot widen an existing workspace), and no grant of the file
is added to a workspace that already exists: grants come only with the workspaces the same import creates. Every item in the plan is `create`, `exists`, `skip` (with the reason) or `failed`.

- Each creation is an ordinary admin API call, so the same checks and the same [audit](audit-log.md) rows apply
  (including the probe that the address really is Agility, and the validation of a token).
- A credential is created only when the file carries its token (sealed) and you give the passphrase; otherwise it is
  `skip` with the command to add it by hand, and workspaces and grants that need it say so (`agility-bridge credential
  add`, then set the workspace's default credential).
- Credentials created are always **shared**; grants are always **service** grants. A personal credential on the target
  with the same label as a shared one in the file is never used or replaced: the item is skipped.
- A workspace that enables write tools or pass-through is skipped unless you add `--allow-sensitive`: read the plan
  first.
- The file must be an agility-bridge export: unknown fields (an owner, a user, a clear token) are refused, it may be
  1 MiB at most, and everything it refers to must be in it.

A wrong passphrase and a file that was changed give the same message, `The passphrase is wrong, or the file was
changed.`.

## Moving to a deployment with another master key

The file is independent of the master key: the tokens are sealed with your passphrase, and the target stores them under
its own master key as they are created. A move between deployments has no other secret to carry. After importing, run
`agility-bridge credential validate <id>` if you want a fresh check, then create the people, grants and device tokens.
