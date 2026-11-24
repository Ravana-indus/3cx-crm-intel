import type { SummaryInput, SummaryResult, Summariser } from './types.js';

/**
 * Deterministic stand-in used in dev and tests. It keeps the whole pipeline
 * (transcript -> summary -> webhook) runnable without an LLM.
 */
export class MockSummariser implements Summariser {
  readonly name = 'mock';
  readonly model = 'mock-v1';

  async summarise(input: SummaryInput): Promise<SummaryResult> {
    const text = input.transcript.toLowerCase();

    const destination = text.includes('germany')
      ? 'Germany'
      : text.includes('canada')
        ? 'Canada'
        : text.includes('australia')
          ? 'Australia'
          : null;

    const service = text.includes('work visa')
      ? 'work visa'
      : text.includes('student')
        ? 'student visa'
        : text.includes('visa')
          ? 'visa'
          : null;

    const sentiment = text.includes('angry') || text.includes('refund')
      ? 'negative'
      : text.includes('thank')
        ? 'positive'
        : 'neutral';

    const summary = [
      `Caller contacted about ${service ?? 'a visa enquiry'}`,
      destination ? ` for ${destination}` : null,
      `. The call was captured from a ${input.call.direction} conversation`,
      input.language ? ` in ${input.language}` : '',
      '.',
    ]
      .filter(Boolean)
      .join('');

    return {
      summary,
      extracted: {
        caller_intent: 'enquiry',
        destination,
        service,
        documents_mentioned: [],
        next_action: 'review the enquiry',
        follow_up_at: null,
        sentiment,
      },
    };
  }
}
