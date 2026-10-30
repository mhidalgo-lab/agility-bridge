// SPDX-License-Identifier: Apache-2.0
// Files the management commands write and read (P8-05): created exclusively with mode 0600 and never through a link;
// read through one descriptor, regular files only, with a size cap.
import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensurePrivateDir, openPrivateFile, UnsafeFileError } from '@agility-bridge/storage-sqlite';
import { ConfigError } from '../config.ts';

/** Writes `text` to a new file (mode 0600, directory 0700 if created); an existing path is refused. */
export function writeNewPrivateFile(path: string, text: string): string {
  const target = resolve(path);
  ensurePrivateDir(dirname(target));
  let file: ReturnType<typeof openPrivateFile>;
  try {
    file = openPrivateFile(target, 'create');
  } catch (error) {
    if (error instanceof UnsafeFileError) throw new ConfigError(error.message);
    throw error;
  }
  try {
    const bytes = new TextEncoder().encode(text);
    for (let off = 0; off < bytes.length; ) off += writeSync(file.fd, bytes, off);
  } finally {
    closeSync(file.fd);
  }
  return target;
}

/** Reads a regular file of at most `maxBytes` without following a link. */
export function readBoundedFile(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(resolve(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(
      code === 'ENOENT'
        ? `${path} does not exist.`
        : code === 'ELOOP'
          ? `${path} is a symbolic link; use the real path.`
          : `${path} cannot be read (${code ?? 'error'}).`,
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ConfigError(`${path} is not a regular file.`);
    if (st.size > maxBytes) throw new ConfigError(`${path} is larger than ${maxBytes} bytes.`);
    const buffer = new Uint8Array(maxBytes + 1);
    let length = 0;
    for (let n = readSync(fd, buffer, 0, buffer.length, null); n > 0 && length <= maxBytes; ) {
      length += n;
      n = readSync(fd, buffer, length, buffer.length - length, null);
    }
    if (length > maxBytes) throw new ConfigError(`${path} is larger than ${maxBytes} bytes.`);
    return new TextDecoder().decode(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
