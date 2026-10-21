// SPDX-License-Identifier: Apache-2.0
// Defensive file handling (L-076, THREAT_MODEL T7, T35): new files are created exclusively with mode 0600 and without
// following symbolic links, directories with 0700, and permissions are checked and tightened on the opened handle, not
// on a path that could have been swapped in between.
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  type Stats,
  statSync,
  writeSync,
} from 'node:fs';

const POSIX = process.platform !== 'win32';
// Windows has no O_NOFOLLOW; symbolic links there need privileges to create, and modes are not POSIX modes.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A file or directory is not safe to use; the message says what to fix. */
export class UnsafeFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnsafeFileError';
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Creates the directory (and missing parents) with mode 0700; warns when an existing one is writable by others. */
export function ensurePrivateDir(dir: string, onWarning: (message: string) => void = () => {}): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = statSync(dir);
  if (!stats.isDirectory()) throw new UnsafeFileError(`${dir} is not a directory.`);
  if (POSIX && (stats.mode & 0o022) !== 0) {
    onWarning(
      `The data directory ${dir} is writable by other users; restrict it (chmod 700) so nobody can swap files.`,
    );
  }
}

export interface OpenedFile {
  fd: number;
  created: boolean;
  stats: Stats;
}

/**
 * Opens a regular file for reading and writing without following a symbolic link, creating it with mode 0600 if it
 * does not exist (`O_EXCL`). An existing file readable or writable by others is tightened to 0600 through the handle.
 */
export function openPrivateFile(
  path: string,
  mode: 'create' | 'open-or-create' = 'open-or-create',
): OpenedFile {
  let fd: number;
  let created = false;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    created = true;
  } catch (error) {
    if (code(error) === 'ELOOP') throw new UnsafeFileError(`${path} is a symbolic link; use the real path.`);
    if (code(error) !== 'EEXIST') throw error;
    if (mode === 'create') throw new UnsafeFileError(`${path} already exists; choose a new file name.`);
    try {
      fd = openSync(path, constants.O_RDWR | NOFOLLOW);
    } catch (inner) {
      if (code(inner) === 'ELOOP')
        throw new UnsafeFileError(`${path} is a symbolic link; use the real path.`);
      throw inner;
    }
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new UnsafeFileError(`${path} is not a regular file.`);
    if (POSIX && (stats.mode & 0o077) !== 0) {
      try {
        fchmodSync(fd, 0o600);
      } catch (error) {
        throw new UnsafeFileError(
          `${path} is accessible to other users and could not be restricted; run chmod 600.`,
          {
            cause: error,
          },
        );
      }
    }
    return { fd, created, stats: fstatSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** True when `path` still names the file behind `stats` (same device and inode, not a symbolic link). */
export function sameFile(path: string, stats: Stats): boolean {
  try {
    const now = lstatSync(path);
    return !now.isSymbolicLink() && now.dev === stats.dev && now.ino === stats.ino;
  } catch {
    return false;
  }
}

/** Copies `source` (not followed if it is a symbolic link) into a new 0600 file `target`. */
export function copyPrivateFile(source: string, target: string): void {
  let input: number;
  try {
    input = openSync(source, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (code(error) === 'ELOOP')
      throw new UnsafeFileError(`${source} is a symbolic link; use the real path.`);
    throw error;
  }
  try {
    if (!fstatSync(input).isFile()) throw new UnsafeFileError(`${source} is not a regular file.`);
    const out = openPrivateFile(target, 'create');
    try {
      const buffer = new Uint8Array(1 << 16);
      for (let n = readSync(input, buffer); n > 0; n = readSync(input, buffer)) {
        for (let off = 0; off < n; ) off += writeSync(out.fd, buffer, off, n - off);
      }
    } finally {
      closeSync(out.fd);
    }
  } finally {
    closeSync(input);
  }
}

/**
 * Reads a small secret file (a master key, an admin token): a regular file, not a symbolic link and, on POSIX, not
 * readable or writable by group or others; the error says how to fix it and never contains the content.
 */
export function readSecretFile(path: string, maxBytes = 4_096): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (code(error) === 'ELOOP') throw new UnsafeFileError(`${path} is a symbolic link; use the real path.`);
    if (code(error) === 'ENOENT') throw new UnsafeFileError(`${path} does not exist.`);
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new UnsafeFileError(`${path} is not a regular file.`);
    if (POSIX && (stats.mode & 0o077) !== 0) {
      throw new UnsafeFileError(`${path} is readable by other users; run chmod 600 ${path}.`);
    }
    if (stats.size > maxBytes) throw new UnsafeFileError(`${path} is larger than ${maxBytes} bytes.`);
    const buffer = new Uint8Array(maxBytes + 1);
    let length = 0;
    for (let n = readSync(fd, buffer, 0, buffer.length, null); n > 0 && length <= maxBytes; ) {
      length += n;
      n = readSync(fd, buffer, length, buffer.length - length, null);
    }
    if (length > maxBytes) throw new UnsafeFileError(`${path} is larger than ${maxBytes} bytes.`);
    return new TextDecoder().decode(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
