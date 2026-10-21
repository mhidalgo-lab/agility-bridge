// SPDX-License-Identifier: Apache-2.0
// Secrets for management commands come from a file, an environment variable, standard input or a hidden prompt —
// never from a flag, which would show in process listings and shell history (L-026, THREAT_MODEL T23).
import { readSecretFile, UnsafeFileError } from '@agility-bridge/storage-sqlite';
import { ConfigError } from '../config.ts';

export interface SecretSources {
  /** `--from-file <path>`: a 0600 file holding the secret. */
  readonly file?: string;
  /** The environment variable to read when no file is given. */
  readonly envName: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads standard input to the end (when it is not a terminal) or prompts without echo (when it is). */
  readonly stdin: () => Promise<string>;
  readonly what: string;
}

export async function readSecret(s: SecretSources): Promise<string> {
  let value: string;
  if (s.file !== undefined) {
    try {
      value = readSecretFile(s.file, 8_192);
    } catch (error) {
      if (error instanceof UnsafeFileError) throw new ConfigError(`--from-file: ${error.message}`);
      throw error;
    }
  } else if (s.env[s.envName] !== undefined && s.env[s.envName] !== '') {
    value = s.env[s.envName] as string;
  } else {
    value = await s.stdin();
  }
  value = value.trim();
  if (value === '') {
    throw new ConfigError(
      `No ${s.what}: pass --from-file <path>, set ${s.envName}, pipe it on standard input, or type it at the prompt.`,
    );
  }
  return value;
}

// From code points: the formatter would turn `\u` escapes into raw control characters (L-166).
const CTRL_C = String.fromCodePoint(0x03);
const DELETE = String.fromCodePoint(0x7f);

/** Standard input of this process: piped text to the end, or a hidden prompt on a terminal. */
export function processStdin(prompt: string): () => Promise<string> {
  return () =>
    new Promise((resolve, reject) => {
      const stdin = process.stdin;
      if (!stdin.isTTY) {
        const chunks: Buffer[] = [];
        let size = 0;
        stdin.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 8_192) {
            stdin.destroy();
            reject(new ConfigError('Standard input is larger than 8 KiB.'));
            return;
          }
          chunks.push(c);
        });
        stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stdin.on('error', reject);
        return;
      }
      process.stderr.write(prompt);
      stdin.setRawMode(true);
      stdin.resume();
      let value = '';
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
            process.stderr.write('\n');
            resolve(value);
            return;
          }
          if (ch === CTRL_C) {
            stdin.setRawMode(false);
            reject(new ConfigError('Cancelled.'));
            return;
          }
          if (ch === DELETE) value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on('data', onData);
    });
}
