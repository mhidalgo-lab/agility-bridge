# Secrets: the master key and stored Agility tokens

> Applies to the self-hosted server (`agility-bridge serve`, v0.2) and later the Cloudflare Worker. The local stdio
> mode stores nothing and needs no master key.

A server keeps each member's Agility access token so that it can call Agility on their behalf. Those tokens never
expire until revoked and carry everything their member may do in Agility, so they are **never stored in plain text**:
each one is encrypted with AES-256-GCM under a key derived from the server's **master key**
([ADR-0007](../adr/0007-secrets-envelope-encryption.md)). After a token is saved, only its last four characters are ever
shown again.

## The master key

- 32 random bytes written as `v<N>:<base64>`, for example `v1:…`; `<N>` is the key version (bare base64 means
  version 1). Generate it with `agility-bridge init`, which writes it to `~/.config/agility-bridge/master.key`
  (`$XDG_CONFIG_HOME`, or `%APPDATA%\agility-bridge` on Windows) with mode `0600`, and never overwrites an existing file.
- Give it to the server in **one** of these ways, never as a command-line flag:
  - `AB_MASTER_KEY_FILE=/path/to/master.key`: the file must be a regular file, not a symbolic link, readable only by
    its owner (`chmod 600`), and **not inside the data directory** (`AB_DATA_DIR`, or the directory of `AB_DB_PATH`);
  - `AB_MASTER_KEY=v1:…` from your secret store (a Docker or Kubernetes secret, a systemd credential, a Worker
    secret), or `AB_MASTER_KEY=keychain:<name>` ([OS keychain](#keeping-secrets-in-the-os-keychain)).
- **Keep it away from the database.** A backup that contains both the database and the key gives away every token.
  Keep the key in a separate secret store, volume or password manager, and back it up separately.
- At start the server checks the key against a key-check value stored the first time that version was used: a wrong
  key, or a different key reusing a known version number, stops the server before anything is decrypted.

## Keeping secrets in the OS keychain

Instead of a file or an environment value, a secret can live in your operating system's keychain and be referred to by
name: `keychain:<name>` (stored under the service `agility-bridge`) or, in the YAML configuration only,
`keychain:<service>/<account>` (an environment value may name the `agility-bridge` service only, so a project's client
file cannot make the server read another application's entry). A reference is
accepted as the whole value of `AB_AGILITY_TOKEN` (stdio), `AB_MASTER_KEY` and `AB_MASTER_KEY_PREVIOUS` (`serve` and the
management commands), and inside `${keychain:…}` in the YAML configuration. The file or client configuration then holds
only the name:

```sh
agility-bridge keychain set agility-token --for-url https://www7.v1host.com/YourInstance   # type or pipe the token; never printed
agility-bridge init --keychain master              # a new master key straight into the keychain
agility-bridge keychain status --name agility-token
```

```json
{ "env": { "AB_AGILITY_URL": "https://www7.v1host.com/YourInstance", "AB_AGILITY_TOKEN": "keychain:agility-token" } }
```

```sh
AB_MASTER_KEY=keychain:master agility-bridge serve
```

### Binding a token to its instance

A client's configuration file can be a project file you did not write, and it can set `AB_AGILITY_URL` to any host while
naming your own entry. So a token is stored **for** an instance: `keychain set <name> --for-url <address>` writes the
token and, next to it, the host (lower case, with the port when it is not the default) in a second entry named
`<name>#host` in the same keychain service. It holds no secret and works the same on macOS, Linux and Windows.

- At start, if `AB_AGILITY_URL` has a different host than the one stored, the server stops before it uses the token and
  prints both hosts on stderr. Nothing in the environment can override this; if the new address really is your
  instance, confirm it yourself: `agility-bridge keychain bind <name> --for-url <new address>`.
- Entries stored before this existed have no host. They still work, with a warning on stderr and in
  `agility-bridge doctor`, so that nothing breaks at an upgrade: run
  `agility-bridge keychain bind <name> --for-url <address>` once. A later release will refuse unbound entries.
- `keychain status --name <name>` prints the bound host (never the token); `keychain delete` removes both entries;
  storing a new token under an existing name keeps its host unless you pass `--for-url`. `doctor` reports a bound
  token as `ok`, an unbound one as a warning and a different host as a failure.
- A `${keychain:...}` in the `instance.token` of your YAML configuration file is checked the same way, against
  `instance.url` of that workspace and before any secret is read. The file may still name any service
  (`${keychain:other-app/token}`), and the binding applies to it too: `keychain bind other-app/token --for-url <address>`
  writes the `#host` entry next to it. A copied or edited file that points an entry at another host stops with both hosts
  named; an unbound entry works with the same warning.
- Master keys (`init --keychain`) belong to a server, not to an instance, and are not bound.

| System | Tool | Notes |
|---|---|---|
| macOS | `security` (the login keychain) | A locked keychain or a prompt the client cannot show is an error. |
| Linux | `secret-tool` (`libsecret-tools`) | Needs a desktop keyring (GNOME Keyring, KWallet) on a session bus; a headless server has none: use a `0600` file. |
| Windows | Credential Manager, through Windows PowerShell | Generic credential named `<service>/<account>`, kept for this machine. |

How it stays safe: no native module is installed; the system tool is started without a shell and a secret is handed to
it on standard input, never as an argument, so it is not visible in a process listing; a missing tool, a locked or
unreachable keychain, a missing entry and a platform without support are errors that name the cause. There is **no
fallback** to a file or to the reference text. `keychain set` reads the entry back to prove it was stored. The keychain
protects against a stolen config file and a leaked repository, not against other software running as you, and it is not
a backup: keep a separate copy of the master key (a lost key loses every stored token). The Windows backend has not yet
been run on a real machine (the maintainers record the check in the release notes).

## Rotating the master key

Rotate on a schedule, when someone who had the key leaves, or after a suspected leak of the key.

1. Generate a new key with a **higher version** and keep the old one:
   `agility-bridge init --key-file ~/.config/agility-bridge/master-v2.key --version 2`.
2. Restart **every** server process with the new key as current and the old one as previous:
   `AB_MASTER_KEY_FILE=new.key` and `AB_MASTER_KEY_FILE_PREVIOUS=old.key` (or `AB_MASTER_KEY` /
   `AB_MASTER_KEY_PREVIOUS`). New and changed tokens are now encrypted with the new key; old ones still open with the
   previous key.
3. Re-encrypt the stored tokens: `agility-bridge keys rotate --reason "<why>"`. Each row is replaced only if nobody
   changed it meanwhile, so it is safe while the server runs; if it stops half-way, run it again and it resumes.
   `agility-bridge keys status` shows how many credentials use each version.
4. When no credential uses the old version, retire it: `agility-bridge keys retire 1 --reason "<why>"` (owners; it
   works locally and through the admin API, so also for a Worker). A retired version can never be
   used as the current key again. Remove the previous key from the configuration and restart.

Every re-encryption and retirement is recorded in the audit log with the credential id, the versions and your reason —
never key material.

## If the database or the key leaks

- **Database or backup leaked, key safe:** the tokens stay encrypted. Rotate the master key anyway if the key could
  have been on the same machine.
- **Key leaked (or both):** rotate the master key **and** ask every member to revoke their Agility access token in
  Agility (*Applications* page) and enter a new one. Encryption cannot protect a token whose key is known.

## If the master key is lost

The stored tokens cannot be recovered. Start the server with a new key at a **new version number**, then have every
member enter their Agility token again (shared credentials too). Credentials still encrypted with the lost version are
reported at start and cannot be used.
