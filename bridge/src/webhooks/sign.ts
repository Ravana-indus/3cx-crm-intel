import { createHmac, timingSafeEqual } from 'node:crypto';

export function signBody(body: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

export function verifyBody(body: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = signBody(body, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
