// SPDX-License-Identifier: Apache-2.0
// The OS keychain (P8-08, ADR-0007, THREAT_MODEL T8, L-103): `keychain:<name>` references keep Agility tokens and the
// master key out of configuration files. No native module: the platform's own tool is run without a shell
// (macOS `security`, Linux `secret-tool`, Windows PowerShell over the Credential Manager API), a secret goes to it on
// standard input and never in its arguments, and a missing tool or a locked store is an error that names the cause:
// there is no silent fallback to a plain file or to an unset value.
import { spawnSync } from 'node:child_process';

/** Raised for every keychain failure; the message names the tool and the reference, never a secret. */
export class KeychainError extends Error {
  override name = 'KeychainError';
}

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** `ENOENT` when the tool is not installed; `TIMEOUT` when it did not answer. */
  readonly failure?: 'ENOENT' | 'TIMEOUT' | 'OTHER';
}

/** Runs a program without a shell; `input` goes to its standard input. Replaced by a fake in tests. */
export type Runner = (
  file: string,
  args: readonly string[],
  input?: string,
  env?: Readonly<Record<string, string>>,
) => RunResult;

const TIMEOUT_MS = 20_000;

export const nodeRunner: Runner = (file, args, input, env) => {
  const r = spawnSync(file, [...args], {
    ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : { input }),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    shell: false,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(code === 'ENOENT'
      ? { failure: 'ENOENT' as const }
      : code === 'ETIMEDOUT'
        ? { failure: 'TIMEOUT' as const }
        : r.error !== undefined
          ? { failure: 'OTHER' as const }
          : {}),
  };
};

export interface KeychainBackend {
  /** What the person sees in messages: `macOS Keychain`, `libsecret (secret-tool)`, `Windows Credential Manager`. */
  readonly label: string;
  /** The secret, or `undefined` when there is no such entry. Throws `KeychainError` when the store cannot be used. */
  get(service: string, account: string): string | undefined;
  /** Stores (or replaces) a secret and reads it back to prove it was stored. */
  set(service: string, account: string, secret: string): void;
  /** True when an entry was removed. */
  delete(service: string, account: string): boolean;
  /** True when the platform tool can be started (no secret is read). */
  available(): boolean;
}

/** The service name used by `keychain:<name>` references that name no service. */
export const DEFAULT_SERVICE = 'agility-bridge';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f]{1,100}$/;

export interface KeychainRef {
  readonly service: string;
  readonly account: string;
}

/**
 * `keychain:name` (service `agility-bridge`) or `keychain:service/account`. Returns undefined when `text` is not a
 * keychain reference at all; throws when it is one but malformed.
 */
export function parseKeychainRef(text: string): KeychainRef | undefined {
  if (!text.startsWith('keychain:')) return undefined;
  const body = text.slice('keychain:'.length);
  const slash = body.indexOf('/');
  const service = slash === -1 ? DEFAULT_SERVICE : body.slice(0, slash);
  const account = slash === -1 ? body : body.slice(slash + 1);
  if (!NO_CONTROL.test(service) || !NO_CONTROL.test(account)) {
    throw new KeychainError(
      'A keychain reference is keychain:<name> or keychain:<service>/<account> (1 to 100 characters each).',
    );
  }
  return { service, account };
}

/** Names that may be written: letters, digits and `. _ @ -`, so nothing needs quoting for any platform tool. */
export function checkWritableName(what: string, value: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new KeychainError(
      `The keychain ${what} must be 1 to 100 characters: letters, digits and . _ @ - (starting with a letter or digit).`,
    );
  }
}

const label = (service: string, account: string) => `"${service}/${account}"`;

function unusable(b: string, r: RunResult, tool: string): KeychainError {
  if (r.failure === 'ENOENT') {
    const install =
      tool === 'secret-tool'
        ? ' Install libsecret-tools (for example `apt install libsecret-tools`) and run a desktop keyring (GNOME Keyring or KWallet).'
        : '';
    return new KeychainError(`${b}: ${tool} is not installed.${install} Nothing falls back to a file.`);
  }
  if (r.failure === 'TIMEOUT') {
    return new KeychainError(`${b}: ${tool} did not answer (a locked keychain waiting for a prompt?).`);
  }
  return new KeychainError(
    `${b}: ${tool} failed (exit ${r.status ?? 'none'}); is the keychain unlocked and reachable?`,
  );
}

function verify(backend: KeychainBackend, service: string, account: string, secret: string): void {
  if (backend.get(service, account) !== secret) {
    throw new KeychainError(
      `${backend.label}: the secret for ${label(service, account)} could not be stored and read back.`,
    );
  }
}

/** The hex of the UTF-8 bytes, for `security -X`: nothing in the secret needs quoting. */
const hex = (text: string) =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');

function macos(run: Runner): KeychainBackend {
  const b = 'macOS Keychain';
  const self: KeychainBackend = {
    label: b,
    get(service, account) {
      const r = run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
      if (r.failure !== undefined) throw unusable(b, r, 'security');
      if (r.status === 0) return r.stdout.replace(/\r?\n$/, '');
      if (r.status === 44 || /could not be found/i.test(r.stderr)) return undefined;
      throw unusable(b, r, 'security');
    },
    set(service, account, secret) {
      checkWritableName('service', service);
      checkWritableName('account', account);
      // `security -i` reads its command from standard input, so the secret (as hex) is not in the argument list.
      const r = run(
        'security',
        ['-i'],
        `add-generic-password -U -s "${service}" -a "${account}" -l "agility-bridge" -X ${hex(secret)}\n`,
      );
      if (r.failure !== undefined) throw unusable(b, r, 'security');
      verify(self, service, account, secret);
    },
    delete(service, account) {
      const r = run('security', ['delete-generic-password', '-s', service, '-a', account]);
      if (r.failure !== undefined) throw unusable(b, r, 'security');
      if (r.status === 0) return true;
      if (r.status === 44 || /could not be found/i.test(r.stderr)) return false;
      throw unusable(b, r, 'security');
    },
    available() {
      return run('security', ['list-keychains']).failure === undefined;
    },
  };
  return self;
}

function linux(run: Runner): KeychainBackend {
  const b = 'libsecret (secret-tool)';
  const attrs = (service: string, account: string) => ['service', service, 'account', account];
  const self: KeychainBackend = {
    label: b,
    get(service, account) {
      const r = run('secret-tool', ['lookup', ...attrs(service, account)]);
      if (r.failure !== undefined) throw unusable(b, r, 'secret-tool');
      if (r.status === 0) return r.stdout.replace(/\r?\n$/, '');
      // `secret-tool` exits 1 with no message when nothing matches; anything it says is a real failure (no D-Bus, locked).
      if (r.status === 1 && r.stderr.trim() === '') return undefined;
      throw unusable(b, r, 'secret-tool');
    },
    set(service, account, secret) {
      checkWritableName('service', service);
      checkWritableName('account', account);
      const r = run('secret-tool', ['store', '--label=agility-bridge', ...attrs(service, account)], secret);
      if (r.failure !== undefined || r.status !== 0) throw unusable(b, r, 'secret-tool');
      verify(self, service, account, secret);
    },
    delete(service, account) {
      if (self.get(service, account) === undefined) return false;
      const r = run('secret-tool', ['clear', ...attrs(service, account)]);
      if (r.failure !== undefined || r.status !== 0) throw unusable(b, r, 'secret-tool');
      return true;
    },
    available() {
      return run('secret-tool', ['--version']).failure === undefined;
    },
  };
  return self;
}

/**
 * Windows Credential Manager through `CredRead`, `CredWrite` and `CredDelete` (advapi32), called from Windows PowerShell
 * with the script in `-EncodedCommand` and the secret on standard input. Generic credential, local-machine persistence,
 * target `service/account`, the password stored as UTF-16 like the Credential Manager's own tools do.
 */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AbCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredWrite(ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static int Get(string target, out string secret) {
    secret = null; IntPtr p;
    if (!CredRead(target, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); return e == 1168 ? 3 : 4; }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      secret = Marshal.PtrToStringUni(c.CredentialBlob, (int)c.CredentialBlobSize / 2);
      return 0;
    } finally { CredFree(p); }
  }
  public static int Set(string target, string user, string secret) {
    byte[] blob = Encoding.Unicode.GetBytes(secret);
    IntPtr mem = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, mem, blob.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
      c.CredentialBlobSize = (uint)blob.Length; c.CredentialBlob = mem;
      return CredWrite(ref c, 0) ? 0 : 4;
    } finally { Marshal.FreeHGlobal(mem); }
  }
  public static int Delete(string target) {
    if (CredDelete(target, 1, 0)) return 0;
    return Marshal.GetLastWin32Error() == 1168 ? 3 : 4;
  }
}
'@
$op = $env:AB_KEYCHAIN_OP
$target = $env:AB_KEYCHAIN_TARGET
if ($op -eq 'get') {
  $s = $null
  $code = [AbCred]::Get($target, [ref]$s)
  if ($code -eq 0) { [Console]::Out.Write($s) }
  exit $code
} elseif ($op -eq 'set') {
  $secret = [Console]::In.ReadToEnd()
  exit ([AbCred]::Set($target, $env:AB_KEYCHAIN_USER, $secret))
} elseif ($op -eq 'delete') {
  exit ([AbCred]::Delete($target))
}
exit 4
`;

const encoded = (script: string): string =>
  btoa(
    String.fromCharCode(...new Uint8Array(new Uint16Array([...script].map((c) => c.charCodeAt(0))).buffer)),
  );

function windows(run: Runner): KeychainBackend {
  const b = 'Windows Credential Manager';
  const ps = (op: 'get' | 'set' | 'delete', service: string, account: string, input?: string): RunResult =>
    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded(WINDOWS_SCRIPT),
      ],
      input,
      // The operation and the target ride in the environment of the child, not in its arguments.
      { AB_KEYCHAIN_OP: op, AB_KEYCHAIN_TARGET: `${service}/${account}`, AB_KEYCHAIN_USER: account },
    );
  const self: KeychainBackend = {
    label: b,
    get(service, account) {
      const r = ps('get', service, account);
      if (r.failure !== undefined) throw unusable(b, r, 'powershell.exe');
      if (r.status === 0) return r.stdout;
      if (r.status === 3) return undefined;
      throw unusable(b, r, 'powershell.exe');
    },
    set(service, account, secret) {
      checkWritableName('service', service);
      checkWritableName('account', account);
      const r = ps('set', service, account, secret);
      if (r.failure !== undefined || r.status !== 0) throw unusable(b, r, 'powershell.exe');
      verify(self, service, account, secret);
    },
    delete(service, account) {
      const r = ps('delete', service, account);
      if (r.failure !== undefined) throw unusable(b, r, 'powershell.exe');
      if (r.status === 0) return true;
      if (r.status === 3) return false;
      throw unusable(b, r, 'powershell.exe');
    },
    available() {
      return (
        run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).failure === undefined
      );
    },
  };
  return self;
}

/** The backend of a platform; a platform without one is an error that says what to use instead. */
export function keychainFor(platform: NodeJS.Platform, run: Runner = nodeRunner): KeychainBackend {
  if (platform === 'darwin') return macos(run);
  if (platform === 'linux') return linux(run);
  if (platform === 'win32') return windows(run);
  throw new KeychainError(
    `There is no keychain support on ${platform}; use an environment variable or a 0600 file for secrets.`,
  );
}

/** Resolves one `keychain:` reference to its secret; a missing entry is an error naming the reference. */
export function readKeychainRef(ref: KeychainRef, backend: KeychainBackend): string {
  const secret = backend.get(ref.service, ref.account);
  if (secret === undefined || secret === '') {
    throw new KeychainError(
      `${backend.label} has no entry ${label(ref.service, ref.account)}; store it with \`agility-bridge keychain set ${ref.service === DEFAULT_SERVICE ? ref.account : `${ref.service}/${ref.account}`}\`.`,
    );
  }
  return secret;
}
