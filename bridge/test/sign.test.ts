import { describe, expect, it } from 'vitest';
import { signBody, verifyBody } from '../src/webhooks/sign.js';
import { signRecording, verifyRecording, recordingUrl } from '../src/api/recordingLink.js';

describe('webhook signing', () => {
  it('verifies a matching signature', () => {
    const body = JSON.stringify({ id: 'evt_1', event: 'call.completed' });
    const signature = signBody(body, 'secret');
    expect(signature.startsWith('sha256=')).toBe(true);
    expect(verifyBody(body, signature, 'secret')).toBe(true);
  });

  it('rejects a wrong secret or a tampered body', () => {
    const body = '{"a":1}';
    const signature = signBody(body, 'secret');
    expect(verifyBody(body, signature, 'other')).toBe(false);
    expect(verifyBody('{"a":2}', signature, 'secret')).toBe(false);
    expect(verifyBody(body, undefined, 'secret')).toBe(false);
  });
});

describe('recording links', () => {
  it('round-trips a signed recording link', () => {
    const now = Date.parse('2026-11-23T00:00:00.000Z');
    const exp = Math.floor(now / 1000) + 60;
    const sig = signRecording('call_1', exp, 'secret');
    expect(verifyRecording('call_1', exp, sig, 'secret', now)).toBe(true);
    expect(verifyRecording('call_2', exp, sig, 'secret', now)).toBe(false);
  });

  it('expires', () => {
    const now = Date.parse('2026-11-23T00:00:00.000Z');
    const exp = Math.floor(now / 1000) - 1;
    const sig = signRecording('call_1', exp, 'secret');
    expect(verifyRecording('call_1', exp, sig, 'secret', now)).toBe(false);
  });

  it('builds an absolute URL when a public base is set', () => {
    const url = recordingUrl(
      'https://bridge.example.com/',
      'call_1',
      'secret',
      900,
      Date.parse('2026-11-23T00:00:00.000Z'),
    );
    expect(url.startsWith('https://bridge.example.com/v1/calls/call_1/recording?')).toBe(
      true,
    );
  });
});
