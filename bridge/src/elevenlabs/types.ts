export interface ElevenLabsKnowledgeDoc {
  id: string;
  name: string;
}

export interface ConversationData {
  conversationId: string;
  transcript: unknown;
  analysis: unknown;
  collected: unknown;
}

export interface ElevenLabsClient {
  createKnowledgeDoc(input: { name: string; text: string }): Promise<ElevenLabsKnowledgeDoc>;
  updateKnowledgeDoc(id: string, input: { name: string; text: string }): Promise<void>;
  deleteKnowledgeDoc(id: string): Promise<void>;
  attachKnowledgeBase(docs: ElevenLabsKnowledgeDoc[]): Promise<void>;
  getConversation(id: string): Promise<ConversationData | null>;
  getSignedUrl(): Promise<string>;
}

export interface ClientToolCall {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

export type TranscriptSpeaker = 'agent' | 'caller';

export interface TranscriptEntry {
  speaker: TranscriptSpeaker;
  text: string;
}

export interface AgentSessionHandlers {
  onAgentAudio(pcm: Buffer): void;
  onInterruption(): void;
  onToolCall(call: ClientToolCall): void;
  onTranscript(entry: TranscriptEntry): void;
  onEnded(): void;
}

export interface AgentSession {
  readonly conversationId: string | null;
  sendCallerAudio(pcm: Buffer): void;
  sendToolResult(toolCallId: string, result: unknown, isError?: boolean): void;
  close(): Promise<void>;
}

export interface AgentSessionFactory {
  open(params: {
    dynamicVariables: Record<string, string>;
    handlers: AgentSessionHandlers;
  }): Promise<AgentSession>;
}
