import { createHmac, timingSafeEqual } from 'node:crypto';

export function signRecording(
  callId: string,
  exp: number,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(`${callId}:${exp}`)
    .digest('base64url');
}

export function verifyRecording(
  callId: string,
  exp: number,
  signature: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!Number.isFinite(exp)) return false;
  if (exp * 1000 < nowMs) return false;

  const expected = Buffer.from(signRecording(callId, exp, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function recordingUrl(
  publicBaseUrl: string | null,
  callId: string,
  secret: string,
  ttlSec: number,
  nowMs = Date.now(),
): string {
  const exp = Math.floor(nowMs / 1000) + ttlSec;
  const signature = signRecording(callId, exp, secret);
  const path = `/v1/calls/${encodeURIComponent(callId)}/recording?exp=${exp}&sig=${encodeURIComponent(signature)}`;
  if (!publicBaseUrl) return path;
  return `${publicBaseUrl.replace(/\/$/, '')}${path}`;
}
