import type {
  AgentSession,
  AgentSessionFactory,
  AgentSessionHandlers,
  ClientToolCall,
  TranscriptEntry,
} from './types.js';

/**
 * Scriptable session used by the mock voice bridge and tests. It records what
 * the bridge sends and lets a test drive agent events.
 */
export class MockAgentSession implements AgentSession {
  readonly conversationId: string;
  readonly sentAudio: Buffer[] = [];
  readonly toolResults: Array<{
    toolCallId: string;
    result: unknown;
    isError: boolean;
  }> = [];
  closed = false;

  constructor(
    readonly handlers: AgentSessionHandlers,
    readonly dynamicVariables: Record<string, string>,
    conversationId = 'mock-conversation-1',
  ) {
    this.conversationId = conversationId;
  }

  sendCallerAudio(pcm: Buffer): void {
    this.sentAudio.push(Buffer.from(pcm));
  }

  sendToolResult(
    toolCallId: string,
    result: unknown,
    isError = false,
  ): void {
    this.toolResults.push({ toolCallId, result, isError });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitAgentAudio(pcm: Buffer): void {
    this.handlers.onAgentAudio(pcm);
  }

  emitInterruption(): void {
    this.handlers.onInterruption();
  }

  emitToolCall(call: ClientToolCall): void {
    this.handlers.onToolCall(call);
  }

  emitTranscript(entry: TranscriptEntry): void {
    this.handlers.onTranscript(entry);
  }

  emitEnded(): void {
    this.handlers.onEnded();
  }
}

export class MockAgentSessionFactory implements AgentSessionFactory {
  readonly sessions: MockAgentSession[] = [];

  async open(params: {
    dynamicVariables: Record<string, string>;
    handlers: AgentSessionHandlers;
  }): Promise<AgentSession> {
    const session = new MockAgentSession(
      params.handlers,
      params.dynamicVariables,
      `mock-conversation-${this.sessions.length + 1}`,
    );
    this.sessions.push(session);
    return session;
  }

  latest(): MockAgentSession | undefined {
    return this.sessions[this.sessions.length - 1];
  }
}
