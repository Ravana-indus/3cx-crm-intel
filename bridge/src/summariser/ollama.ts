import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { stripCodeFences, systemPrompt, userPrompt } from './prompt.js';
import { summaryResultSchema } from './schema.js';
import type { SummaryInput, SummaryResult, Summariser } from './types.js';

export type SummariserFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaSummariser implements Summariser {
  readonly name = 'ollama';
  readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(
    config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: SummariserFetch = fetch,
  ) {
    this.model = config.ollamaModel;
    this.url = config.ollamaUrl.replace(/\/$/, '');
    this.timeoutMs = config.ollamaTimeoutMs;
  }

  async summarise(input: SummaryInput): Promise<SummaryResult> {
    const response = await this.fetchImpl(`${this.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(input) },
        ],
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as OllamaChatResponse;
    if (body.error) throw new Error(`Ollama error: ${body.error}`);

    const content = body.message?.content;
    if (!content) throw new Error('Ollama returned no message content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFences(content));
    } catch {
      throw new Error('Ollama returned invalid JSON');
    }

    const validated = summaryResultSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new Error(`Ollama JSON failed schema: ${issues}`);
    }

    this.log.debug({ model: this.model }, 'ollama summary complete');
    return {
      summary: validated.data.summary,
      extracted: validated.data.extracted,
    };
  }
}
