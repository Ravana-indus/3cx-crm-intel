import { describe, expect, it } from 'vitest';
import { normalisePhone } from '../src/util/phone.js';

describe('normalisePhone', () => {
  it('normalises a local LK number to E.164', () => {
    const result = normalisePhone('0771234567');
    expect(result.e164).toBe('+94771234567');
    expect(result.valid).toBe(true);
    expect(result.raw).toBe('0771234567');
  });

  it('accepts an already international number', () => {
    expect(normalisePhone('+94 77 123 4567').e164).toBe('+94771234567');
  });

  it('returns null for empty or junk input', () => {
    expect(normalisePhone('').e164).toBeNull();
    expect(normalisePhone(null).e164).toBeNull();
    expect(normalisePhone('definitely-not-a-number').e164).toBeNull();
  });
});
