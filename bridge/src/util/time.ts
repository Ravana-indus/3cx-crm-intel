const COLOMBO_OFFSET = '+05:30';

export function toUtcIso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}

/**
 * Store times as UTC, return them in Asia/Colombo time from the API.
 * Sri Lanka has no DST, so the offset is a constant +05:30.
 */
export function toColombo(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') === '24' ? '00' : get('hour');

  return `${year}-${month}-${day}T${hour}:${get('minute')}:${get('second')}${COLOMBO_OFFSET}`;
}

export function subtractMs(value: Date | string, ms: number): Date {
  return new Date(new Date(value).getTime() - ms);
}

export function parseDateOr(value: string | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date-only inputs are interpreted as Asia/Colombo local days, so "from=2026-11-20"
 * means 00:00 Colombo, not 00:00 UTC (which is 05:30 Colombo).
 */
export function parseColomboRange(
  from?: string,
  to?: string,
  now = new Date(),
): { from: Date; to: Date } {
  const defaultTo = now;
  const defaultFrom = new Date(now.getTime() - 7 * 86_400_000);

  const start = from
    ? DATE_ONLY.test(from)
      ? new Date(`${from}T00:00:00.000+05:30`)
      : new Date(from)
    : defaultFrom;
  const end = to
    ? DATE_ONLY.test(to)
      ? new Date(`${to}T23:59:59.999+05:30`)
      : new Date(to)
    : defaultTo;

  return {
    from: Number.isNaN(start.getTime()) ? defaultFrom : start,
    to: Number.isNaN(end.getTime()) ? defaultTo : end,
  };
}

export function colomboDayKey(value: Date | string | number): string {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nextColomboMidnightMs(value: Date | string | number): number {
  const key = colomboDayKey(value);
  return Date.parse(`${key}T00:00:00.000+05:30`) + 86_400_000;
}

export function weekStartOfDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, date, 12));
  const delta = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - delta);
  return value.toISOString().slice(0, 10);
}

export function colomboHourMinute(value: Date | string | number): {
  hour: number;
  minute: number;
} {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(
    parts.find((part) => part.type === type)?.value ?? '0',
  );
  return { hour: get('hour') % 24, minute: get('minute') };
}
