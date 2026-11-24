import type {
  ConversationData,
  ElevenLabsClient,
  ElevenLabsKnowledgeDoc,
} from './types.js';

/**
 * In-memory ElevenLabs used in dev and tests. It behaves like the real
 * knowledge-base and conversations API closely enough to exercise the sync and
 * post-call paths.
 */
export class MockElevenLabs implements ElevenLabsClient {
  private readonly docs = new Map<string, { name: string; text: string }>();
  private attached: ElevenLabsKnowledgeDoc[] = [];
  private readonly conversations = new Map<string, ConversationData>();
  private counter = 0;

  async createKnowledgeDoc(input: {
    name: string;
    text: string;
  }): Promise<ElevenLabsKnowledgeDoc> {
    this.counter += 1;
    const id = `el_doc_${this.counter}`;
    this.docs.set(id, { name: input.name, text: input.text });
    return { id, name: input.name };
  }

  async updateKnowledgeDoc(
    id: string,
    input: { name: string; text: string },
  ): Promise<void> {
    if (!this.docs.has(id)) throw new Error(`mock knowledge doc not found: ${id}`);
    this.docs.set(id, { name: input.name, text: input.text });
  }

  async deleteKnowledgeDoc(id: string): Promise<void> {
    this.docs.delete(id);
    this.attached = this.attached.filter((doc) => doc.id !== id);
  }

  async attachKnowledgeBase(docs: ElevenLabsKnowledgeDoc[]): Promise<void> {
    this.attached = docs.map((doc) => ({ ...doc }));
  }

  async getConversation(id: string): Promise<ConversationData | null> {
    const seeded = this.conversations.get(id);
    if (seeded) return seeded;

    return {
      conversationId: id,
      transcript: [
        { role: 'agent', message: 'Hello, how can I help?' },
        { role: 'user', message: 'I need a work visa for Germany.' },
      ],
      analysis: {
        transcript_summary: 'Caller asked about a German work visa.',
        data_collection_results: { destination: 'Germany' },
      },
      collected: { destination: 'Germany' },
    };
  }

  async getSignedUrl(): Promise<string> {
    return 'ws://127.0.0.1/mock-elevenlabs';
  }

  // Test/dev helpers -------------------------------------------------------
  remoteDocs(): Array<{ id: string; name: string; text: string }> {
    return [...this.docs.entries()].map(([id, doc]) => ({ id, ...doc }));
  }

  attachedDocs(): ElevenLabsKnowledgeDoc[] {
    return this.attached.map((doc) => ({ ...doc }));
  }

  seedConversation(id: string, data: ConversationData): void {
    this.conversations.set(id, data);
  }
}
