import { maskPhone, redact } from './util.ts';

/**
 * Structured logging.
 *
 * Output was human-readable prose with no request id, no duration and nothing
 * machine-parseable, so production debugging meant reading sentences. This adds
 * a second, structured stream without taking the readable one away: the CLI is
 * an operator tool and should keep printing for people, while a server running
 * unattended should emit something a log pipeline can filter.
 *
 * The important property here is not the format. It is that a secret or a phone
 * number cannot reach the output by accident, which is enforced on the way out
 * rather than trusted to every call site.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

/**
 * Field names whose values never appear in output, whatever they contain.
 *
 * A deny-list is the wrong shape for secrets in general - you cannot enumerate
 * every name somebody will invent. It is here as the last of three defences,
 * after `redact()` on the value and the rule that nothing passes a raw request
 * body to the logger. Anything matching is dropped entirely rather than
 * redacted, because the safest rendering of a password is no rendering.
 */
const NEVER_LOG = /token|secret|password|api[_-]?key|authorization|credential|cookie|signature/i;

/** Field names carrying personal data, shown partially rather than dropped. */
const MASK_AS_PHONE = /phone|msisdn|to_number|caller/i;

/**
 * Make one value safe to print.
 *
 * Applied to every value, at every depth, on the way out. Depth is bounded: a
 * cyclic or enormous object should not be able to hang the logger.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (NEVER_LOG.test(key)) continue;
      if (MASK_AS_PHONE.test(key) && typeof v === 'string') {
        out[key] = maskPhone(v);
        continue;
      }
      out[key] = scrub(v, depth + 1);
    }
    return out;
  }

  // bigint and symbol stringify usefully; a function does not, and one reaching
  // the logger is a mistake worth seeing rather than rendering as [object].
  if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString();
  return '[unserializable]';
}

export interface LoggerOptions {
  level?: Level;
  /** 'json' for a log pipeline, 'pretty' for a person. */
  format?: 'json' | 'pretty';
  write?: (line: string) => void;
  /** Fields attached to every line from this logger. */
  base?: LogFields;
  now?: () => Date;
}

export class Logger {
  readonly #level: number;
  readonly #format: 'json' | 'pretty';
  readonly #write: (line: string) => void;
  readonly #base: LogFields;
  readonly #now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.#level = ORDER[options.level ?? (process.env.FL_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;
    this.#format = options.format ?? (process.env.FL_LOG_FORMAT === 'json' ? 'json' : 'pretty');
    // stderr, so structured logs never interleave with command output that a
    // caller might be piping somewhere.
    this.#write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    this.#base = options.base ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  /** A logger carrying extra context - a request id, a run id - on every line. */
  child(fields: LogFields): Logger {
    return new Logger({
      level: (Object.keys(ORDER) as Level[]).find((l) => ORDER[l] === this.#level) ?? 'info',
      format: this.#format,
      write: this.#write,
      base: { ...this.#base, ...fields },
      now: this.#now,
    });
  }

  debug(event: string, fields: LogFields = {}): void {
    this.#emit('debug', event, fields);
  }
  info(event: string, fields: LogFields = {}): void {
    this.#emit('info', event, fields);
  }
  warn(event: string, fields: LogFields = {}): void {
    this.#emit('warn', event, fields);
  }
  error(event: string, fields: LogFields = {}): void {
    this.#emit('error', event, fields);
  }

  #emit(level: Level, event: string, fields: LogFields): void {
    if (ORDER[level] < this.#level) return;
    const record = scrub({ ...this.#base, ...fields }) as LogFields;
    const at = this.#now().toISOString();

    if (this.#format === 'json') {
      this.#write(JSON.stringify({ at, level, event, ...record }));
      return;
    }

    const rendered = Object.entries(record)
      // Strings render bare so a path or an id stays readable; everything else
      // goes through JSON so an object cannot become "[object Object]".
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined')}`)
      .join(' ');
    this.#write(`${at} ${level.toUpperCase().padEnd(5)} ${event}${rendered ? ` ${rendered}` : ''}`);
  }
}

/** The process-wide logger. Commands that print for people keep using write(). */
export const log = new Logger();
