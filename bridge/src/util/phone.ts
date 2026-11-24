import { parsePhoneNumberFromString } from 'libphonenumber-js';

export interface NormalisedPhone {
  raw: string;
  e164: string | null;
  valid: boolean;
}

/**
 * Normalise a dialled number to E.164. Default region is LK, so
 * 0771234567 becomes +94771234567. Raw and normalised forms are both stored.
 */
export function normalisePhone(
  raw: string | null | undefined,
  defaultCountry: 'LK' = 'LK',
): NormalisedPhone {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') {
    return { raw: trimmed, e164: null, valid: false };
  }

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed) {
    return { raw: trimmed, e164: null, valid: false };
  }

  return {
    raw: trimmed,
    e164: parsed.number,
    valid: parsed.isValid(),
  };
}
