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
/** The national subscriber length this module assumes (IN, and most of its peers). */
const NATIONAL_DIGITS = 10;

/** Formatting a person or a form might introduce, and nothing else. */
const SEPARATORS = /[\s\-().]/g;

export function toE164(raw: string, defaultCountryCode: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new PhoneError('empty phone number');

  const cc = defaultCountryCode.replace(/[^0-9]/g, '');
  if (!cc) throw new PhoneError('defaultCountryCode must contain digits, e.g. "91"');

  // Strip only real formatting. Anything else left over - letters, "ext", a
  // second number - means this field holds something other than one phone
  // number, and stripping it silently used to turn "9876543210 ext 22" into
  // +91987654321022: a different number, dialled at a stranger.
  const cleaned = trimmed.replace(SEPARATORS, '');
  const body = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^[0-9]+$/.test(body)) {
    throw new PhoneError(`"${raw}" is not a single phone number; remove extensions and any other text`);
  }

  if (cleaned.startsWith('+')) return international(body, cc, raw);
  if (body.startsWith('00')) return international(body.slice(2), cc, raw);

  // Already carries the country code.
  if (body.startsWith(cc) && body.length === cc.length + NATIONAL_DIGITS) return plausible(body, raw);

  // National, possibly behind a trunk prefix.
  const national = body.replace(/^0+/, '');
  if (national.length !== NATIONAL_DIGITS) {
    throw new PhoneError(
      `cannot normalize "${raw}" with country code +${cc}: expected ${NATIONAL_DIGITS} national digits, got ${national.length}`,
    );
  }
  return plausible(`${cc}${national}`, raw);
}

/**
 * An explicitly international number.
 *
 * The length floor is the point. A "+" in front of a bare national number is a
 * common way for a form to be filled in, and it used to be taken at face value:
 * "+9876543210" became +9876543210 rather than +919876543210. That is a
 * different number - possibly a real one belonging to somebody else - and it
 * also walks straight past the suppression list, because an opt-out is recorded
 * against the normalized form. Anything short enough to be a national number in
 * disguise is refused rather than guessed at.
 */
function international(digits: string, cc: string, raw: string): string {
  // Checked first so junk gets the accurate reason rather than "ambiguous".
  if (digits.startsWith('0')) throw new PhoneError(`"${raw}" has no valid country code`);
  if (digits.startsWith(cc)) {
    if (digits.length !== cc.length + NATIONAL_DIGITS) {
      throw new PhoneError(`"${raw}" is +${cc} but not ${NATIONAL_DIGITS} national digits long`);
    }
    return plausible(digits, raw);
  }
  if (digits.length <= NATIONAL_DIGITS) {
    throw new PhoneError(
      `"${raw}" is ambiguous: ${digits.length} digits after "+" could be a national number with a stray plus. Store it in full E.164, e.g. +${cc}${'9'.repeat(NATIONAL_DIGITS)}`,
    );
  }
  if (digits.length > 15) throw new PhoneError(`implausible international number: ${raw}`);
  return plausible(digits, raw);
}

/** A last look for the shapes that are digits but not numbers. */
function plausible(digits: string, raw: string): string {
  if (digits.startsWith('0')) throw new PhoneError(`"${raw}" starts with a zero country code`);
  // The subscriber part, not the whole string: +919999999999 has two distinct
  // digits overall and is still somebody filling in a form to get past it.
  const subscriber = digits.slice(-NATIONAL_DIGITS);
  if (new Set(subscriber).size === 1) throw new PhoneError(`"${raw}" is one repeated digit, not a number`);
  return `+${digits}`;
}

/**
 * How many minor units make one of a currency, per the runtime's own ISO data.
 *
 * Not every currency is 100. JPY, KRW and VND have no minor unit at all (1),
 * KWD and BHD have 1000. That matters here because Meta takes budgets in the
 * account currency's smallest unit: this system stores minor units assuming
 * 100, so on a yen account a budget it means as "1,000.00" is sent as 100000
 * and buys a 100,000 yen/day campaign.
 *
 * Throws on a code the runtime does not recognise, which is the validation.
 */
export function minorUnitsPer(currency: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return 10 ** digits;
}

/**
 * Every amount in this system is an integer of 1/100 of a major unit, and the
 * conversions, the CLI and the money formatter all assume it. Rather than
 * silently misprice an account whose currency does not work that way, the
 * control layer refuses it - a stated limitation instead of a 100x surprise.
 */
export function isSupportedCurrency(currency: string): boolean {
  try {
    return minorUnitsPer(currency) === 100;
  } catch {
    return false;
  }
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
