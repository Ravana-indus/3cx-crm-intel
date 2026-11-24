import { describe, expect, it } from 'vitest';
import { MockSummariser } from '../src/summariser/mock.js';
import { OllamaSummariser, type SummariserFetch } from '../src/summariser/ollama.js';
import { summaryResultSchema } from '../src/summariser/schema.js';
import type { SummaryInput } from '../src/summariser/types.js';
import { createLogger } from '../src/util/logger.js';
import { callInput, testConfig, testContext } from './helpers.js';

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  const ctx = testContext();
  const call = ctx.calls.upsert(callInput()).row;
  ctx.db.close();
  return {
    transcript: 'I want a work visa for Germany, thank you',
    language: 'en',
    call,
    hints: [],
    ...overrides,
  };
}

describe('MockSummariser', () => {
  it('returns schema-valid structured output', async () => {
    const result = await new MockSummariser().summarise(input());

    expect(summaryResultSchema.safeParse(result).success).toBe(true);
    expect(result.extracted.destination).toBe('Germany');
    expect(result.extracted.service).toBe('work visa');
    expect(result.extracted.sentiment).toBe('positive');
  });
});

describe('OllamaSummariser', () => {
  const config = testConfig({ summariser: 'ollama', ollamaModel: 'test-model' });
  const log = createLogger('silent');
  const valid = {
    summary: 'The caller asked about a German work visa.',
    extracted: {
      caller_intent: 'visa enquiry',
      destination: 'Germany',
      service: 'work visa',
      documents_mentioned: ['passport'],
      next_action: 'send fee list',
      follow_up_at: '2026-11-25',
      sentiment: 'positive',
    },
  };

  function respond(content: string): SummariserFetch {
    return async () =>
      new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }

  it('parses JSON, including fenced output', async () => {
    const summariser = new OllamaSummariser(
      config,
      log,
      respond('```json\n' + JSON.stringify(valid) + '\n```'),
    );

    const result = await summariser.summarise(input());
    expect(result.extracted.destination).toBe('Germany');
    expect(result.extracted.follow_up_at).toBe('2026-11-25');
  });

  it('rejects output that fails the schema', async () => {
    const summariser = new OllamaSummariser(
      config,
      log,
      respond(JSON.stringify({ summary: 'x', extracted: { sentiment: 'angry' } })),
    );

    await expect(summariser.summarise(input())).rejects.toThrow(/schema/i);
  });

  it('rejects non-JSON output', async () => {
    const summariser = new OllamaSummariser(config, log, respond('not json'));
    await expect(summariser.summarise(input())).rejects.toThrow(/invalid JSON/i);
  });
});
