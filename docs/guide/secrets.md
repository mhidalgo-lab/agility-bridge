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
- Give it to the server in **one** of two ways, never as a command-line flag:
  - `AB_MASTER_KEY_FILE=/path/to/master.key`: the file must be a regular file, not a symbolic link, readable only by
    its owner (`chmod 600`), and **not inside the data directory** (`AB_DATA_DIR`, or the directory of `AB_DB_PATH`);
  - `AB_MASTER_KEY=v1:…` from your secret store (a Docker or Kubernetes secret, a systemd credential, a Worker
    secret).
- **Keep it away from the database.** A backup that contains both the database and the key gives away every token.
  Keep the key in a separate secret store, volume or password manager, and back it up separately.
- At start the server checks the key against a key-check value stored the first time that version was used: a wrong
  key, or a different key reusing a known version number, stops the server before anything is decrypted.

## Rotating the master key

Rotate on a schedule, when someone who had the key leaves, or after a suspected leak of the key.

1. Generate a new key with a **higher version** (for example `v2:…`) and keep the old one.
2. Restart **every** server process with the new key as current and the old one as previous:
   `AB_MASTER_KEY_FILE=new.key` and `AB_MASTER_KEY_FILE_PREVIOUS=old.key` (or `AB_MASTER_KEY` /
   `AB_MASTER_KEY_PREVIOUS`). New and changed tokens are now encrypted with the new key; old ones still open with the
   previous key.
3. Re-encrypt the stored tokens: `agility-bridge keys rotate --reason "<why>"`. Each row is replaced only if nobody
   changed it meanwhile, so it is safe while the server runs; if it stops half-way, run it again and it resumes.
   `agility-bridge keys status` shows how many credentials use each version.
4. When no credential uses the old version, retire it: `agility-bridge keys retire 1`. A retired version can never be
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
