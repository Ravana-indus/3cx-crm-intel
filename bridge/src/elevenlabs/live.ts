import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import type {
  ConversationData,
  ElevenLabsClient,
  ElevenLabsKnowledgeDoc,
} from './types.js';

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * ElevenLabs ConvAI API. The knowledge-base attach shape is isolated in
 * attachKnowledgeBase() because it is the piece most likely to differ between
 * API revisions; confirm it against the live account before enabling.
 */
export class LiveElevenLabs implements ElevenLabsClient {
  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async createKnowledgeDoc(input: {
    name: string;
    text: string;
  }): Promise<ElevenLabsKnowledgeDoc> {
    const body = await this.request('/v1/convai/knowledge-base', {
      method: 'POST',
      body: JSON.stringify({ name: input.name, text: input.text }),
    });

    const id = String((body as { id?: unknown }).id ?? '');
    if (!id) throw new Error('ElevenLabs did not return a knowledge document id');
    return { id, name: input.name };
  }

  async updateKnowledgeDoc(
    id: string,
    input: { name: string; text: string },
  ): Promise<void> {
    await this.request(
      `/v1/convai/knowledge-base/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ name: input.name, text: input.text }),
      },
    );
  }

  async deleteKnowledgeDoc(id: string): Promise<void> {
    await this.request(
      `/v1/convai/knowledge-base/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  async attachKnowledgeBase(docs: ElevenLabsKnowledgeDoc[]): Promise<void> {
    const agentId = this.requireAgentId();
    // Isolated API shape: document references live under the agent prompt.
    const payload = {
      conversation_config: {
        agent: {
          prompt: {
            knowledge_base: docs.map((doc) => ({
              type: 'text',
              id: doc.id,
              name: doc.name,
              usage_mode: 'auto',
            })),
          },
        },
      },
    };

    await this.request(`/v1/convai/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  async getConversation(id: string): Promise<ConversationData | null> {
    const body = (await this.request(
      `/v1/convai/conversations/${encodeURIComponent(id)}`,
      { method: 'GET' },
    )) as Record<string, unknown>;

    return {
      conversationId: id,
      transcript: body.transcript ?? null,
      analysis: body.analysis ?? null,
      collected:
        (body.analysis as { data_collection_results?: unknown } | undefined)
          ?.data_collection_results ?? null,
    };
  }

  async getSignedUrl(): Promise<string> {
    const agentId = this.requireAgentId();
    const body = (await this.request(
      `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { method: 'GET' },
    )) as { signed_url?: string; signedUrl?: string };

    const url = body.signed_url ?? body.signedUrl;
    if (!url) throw new Error('ElevenLabs did not return a signed conversation URL');
    return url;
  }

  private requireAgentId(): string {
    if (!this.config.elevenLabsAgentId) {
      throw new Error('ELEVENLABS_AGENT_ID is required in live mode');
    }
    return this.config.elevenLabsAgentId;
  }

  private async request(
    path: string,
    init: { method: string; body?: string },
  ): Promise<unknown> {
    if (!this.config.elevenLabsApiKey) {
      throw new Error('ELEVENLABS_API_KEY is required in live mode');
    }

    const response = await this.fetchImpl(
      `${this.config.elevenLabsBaseUrl}${path}`,
      {
        method: init.method,
        headers: {
          'xi-api-key': this.config.elevenLabsApiKey,
          'content-type': 'application/json',
        },
        body: init.body,
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `ElevenLabs ${response.status} ${init.method} ${path}: ${detail.slice(0, 300)}`,
      );
    }

    this.log.debug({ path, method: init.method }, 'elevenlabs request ok');
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  }
}
