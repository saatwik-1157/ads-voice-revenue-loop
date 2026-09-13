import { randomUUID, createHash } from 'node:crypto';

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function now(): string {
  return new Date().toISOString();
}

/**
 * Deterministic key used for idempotency: the same logical operation must never
 * create two campaigns or place two calls, however many times a retry fires.
 */
export function fingerprint(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export class PhoneError extends Error {}

/**
 * Normalize a lead phone number to E.164.
 *
 * This is intentionally conservative: it accepts an explicit "+" prefix, or a
 * national number that it can pair with the run's default country code. Anything
 * ambiguous is rejected rather than guessed, because a wrong number means an
 * unsolicited call to a stranger.
 */
export function toE164(raw: string, defaultCountryCode: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new PhoneError('empty phone number');

  const cc = defaultCountryCode.replace(/[^0-9]/g, '');
  if (!cc) throw new PhoneError('defaultCountryCode must contain digits, e.g. "91"');

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/[^0-9]/g, '');
    if (digits.length < 8 || digits.length > 15) {
      throw new PhoneError(`implausible international number: ${raw}`);
    }
    return `+${digits}`;
  }

  let digits = trimmed.replace(/[^0-9]/g, '');
  // 00-prefixed international dialling
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    if (digits.length < 8 || digits.length > 15) throw new PhoneError(`implausible number: ${raw}`);
    return `+${digits}`;
  }
  // Already carries the country code
  if (digits.startsWith(cc) && digits.length === cc.length + 10) {
    return `+${digits}`;
  }
  // National trunk prefix
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (digits.length < 7 || digits.length > 12) {
    throw new PhoneError(`cannot normalize "${raw}" with country code +${cc}`);
  }
  return `+${cc}${digits}`;
}

export function minor(amount: number): number {
  return Math.round(amount * 100);
}

export function money(minorUnits: number, currency = 'INR'): string {
  const sign = minorUnits < 0 ? '-' : '';
  const abs = Math.abs(minorUnits);
  return `${sign}${currency} ${(abs / 100).toFixed(2)}`;
}

export function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Redact anything that looks like a secret before it reaches a log line. */
export function redact(value: string): string {
  return value
    .replace(/\b(EAA[A-Za-z0-9]{10,})\b/g, 'EAA***redacted***')
    .replace(/\b(sk-[A-Za-z0-9_-]{10,})\b/g, 'sk-***redacted***')
    .replace(/("?(?:access_token|api_key|apiKey|authorization|secret)"?\s*[:=]\s*"?)([^",\s]+)/gi, '$1***redacted***');
}

/** Show only the last 4 digits of a phone number in logs and reports. */
export function maskPhone(e164: string): string {
  return e164.length <= 4 ? '****' : `${e164.slice(0, 3)}${'*'.repeat(Math.max(0, e164.length - 7))}${e164.slice(-4)}`;
}
