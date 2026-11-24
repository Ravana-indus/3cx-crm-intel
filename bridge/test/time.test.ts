import { describe, expect, it } from 'vitest';
import { parseDateOr, toColombo } from '../src/util/time.js';

describe('time helpers', () => {
  it('renders UTC as Asia/Colombo time', () => {
    expect(toColombo('2026-11-20T04:30:00.000Z')).toBe(
      '2026-11-20T10:00:00+05:30',
    );
  });

  it('handles null', () => {
    expect(toColombo(null)).toBeNull();
    expect(toColombo(undefined)).toBeNull();
  });

  it('falls back when a date is missing or invalid', () => {
    const fallback = new Date('2026-01-01T00:00:00.000Z');
    expect(parseDateOr(undefined, fallback)).toBe(fallback);
    expect(parseDateOr('nonsense', fallback)).toBe(fallback);
    expect(parseDateOr('2026-02-02T00:00:00.000Z', fallback).toISOString()).toBe(
      '2026-02-02T00:00:00.000Z',
    );
  });
});
