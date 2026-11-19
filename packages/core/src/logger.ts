// SPDX-License-Identifier: Apache-2.0
import { redact, redactValue } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line (e.g. requestId, tool). */
  child(fields: LogFields): Logger;
}

/** Receives one already-redacted JSON line and the record's level. */
export type LogSink = (line: string, level: LogLevel) => void;

/**
 * Default sink: `console.error`, which is **stderr** on Node (stdout is the stdio MCP channel) and Workers Logs on
 * Workers. Nothing in this project logs to stdout.
 */
export const stderrSink: LogSink = (line) => console.error(line);

/**
 * Sink for Cloudflare Workers (P9-28): the console method follows the record's level. Workers Logs files a line by the
 * method that wrote it, so `console.error` for every line made each `info` record an error and filled issue detection
 * with false issues. Never use it on Node, where `console.log` and `console.info` write to stdout.
 */
export const consoleLevelSink: LogSink = (line, level) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  // biome-ignore lint/suspicious/noConsole: Workers only, where the console method is the log level (L-508); Node never uses this sink.
  else if (level === 'info') console.info(line);
  // biome-ignore lint/suspicious/noConsole: as above.
  else console.debug(line);
};

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  now?: () => number;
  fields?: LogFields;
}

const RESERVED = ['ts', 'level', 'msg'] as const;

/** A caller field can never forge the record's timestamp, level or message: it is kept as `field_<name>`. */
function renameReserved(fields: LogFields): LogFields {
  if (!RESERVED.some((k) => Object.hasOwn(fields, k))) return fields;
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[(RESERVED as readonly string[]).includes(key) ? `field_${key}` : key] = value;
  }
  return out;
}

/** Structured JSON logger. Redaction is mandatory: messages and fields always pass through `redact`. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVEL_RANK[options.level ?? 'info'];
  const sink = options.sink ?? stderrSink;
  const now = options.now ?? Date.now;
  const base = options.fields ?? {};
  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < min) return;
    const record = {
      ts: new Date(now()).toISOString(),
      level,
      msg: redact(msg),
      ...(redactValue(renameReserved({ ...base, ...fields })) as LogFields),
    };
    try {
      sink(JSON.stringify(record), level);
    } catch {
      // Logging must never break a request.
    }
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
