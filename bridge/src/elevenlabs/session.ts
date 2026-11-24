import WebSocket, { type RawData } from 'ws';
import type { Logger } from '../util/logger.js';
import type {
  AgentSession,
  AgentSessionFactory,
  AgentSessionHandlers,
  ElevenLabsClient,
} from './types.js';

interface ElevenLabsMessage {
  type?: string;
  [key: string]: unknown;
}

/**
 * One ElevenLabs Agents conversation. Caller PCM goes up as user_audio_chunk;
 * agent audio comes back base64 and is handed to the audio transport.
 */
export class LiveAgentSession implements AgentSession {
  private conversationIdValue: string | null = null;
  private ended = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly handlers: AgentSessionHandlers,
    private readonly dynamicVariables: Record<string, string>,
    private readonly log: Logger,
  ) {
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('close', () => this.fireEnded());
    socket.on('error', (error) => {
      this.log.warn({ error: String(error) }, 'ElevenLabs socket error');
      this.fireEnded();
    });

    if (socket.readyState === WebSocket.OPEN) this.sendInitiation();
    else socket.once('open', () => this.sendInitiation());
  }

  get conversationId(): string | null {
    return this.conversationIdValue;
  }

  sendCallerAudio(pcm: Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.send({ user_audio_chunk: pcm.toString('base64') });
  }

  sendToolResult(
    toolCallId: string,
    result: unknown,
    isError = false,
  ): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.send({
      type: 'client_tool_result',
      tool_call_id: toolCallId,
      result: typeof result === 'string' ? result : JSON.stringify(result),
      is_error: isError,
    });
  }

  async close(): Promise<void> {
    this.fireEnded();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }

  private sendInitiation(): void {
    this.send({
      type: 'conversation_initiation_client_data',
      dynamic_variables: this.dynamicVariables,
    });
  }

  private send(payload: unknown): void {
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.log.warn({ error: String(error) }, 'failed to send ElevenLabs frame');
    }
  }

  private fireEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.handlers.onEnded();
  }

  private handleMessage(raw: RawData): void {
    let message: ElevenLabsMessage;
    try {
      message = JSON.parse(raw.toString()) as ElevenLabsMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'conversation_initiation_metadata': {
        const meta = message.conversation_initiation_metadata_event as
          | { conversation_id?: string }
          | undefined;
        this.conversationIdValue = meta?.conversation_id ?? null;
        break;
      }
      case 'audio': {
        const event = message.audio_event as
          | { audio_base_64?: string }
          | undefined;
        if (event?.audio_base_64) {
          this.handlers.onAgentAudio(Buffer.from(event.audio_base_64, 'base64'));
        }
        break;
      }
      case 'interruption':
        this.handlers.onInterruption();
        break;
      case 'client_tool_call': {
        const call = message.client_tool_call as
          | {
              tool_name?: string;
              tool_call_id?: string;
              parameters?: Record<string, unknown>;
            }
          | undefined;
        if (call?.tool_name && call.tool_call_id) {
          this.handlers.onToolCall({
            toolName: call.tool_name,
            toolCallId: call.tool_call_id,
            parameters: call.parameters ?? {},
          });
        }
        break;
      }
      case 'user_transcript': {
        const event = message.user_transcription_event as
          | { user_transcript?: string }
          | undefined;
        if (event?.user_transcript) {
          this.handlers.onTranscript({
            speaker: 'caller',
            text: event.user_transcript,
          });
        }
        break;
      }
      case 'agent_response': {
        const event = message.agent_response_event as
          | { agent_response?: string }
          | undefined;
        if (event?.agent_response) {
          this.handlers.onTranscript({
            speaker: 'agent',
            text: event.agent_response,
          });
        }
        break;
      }
      case 'ping': {
        const event = message.ping_event as { event_id?: number } | undefined;
        this.send({ type: 'pong', event_id: event?.event_id });
        break;
      }
      case 'conversation_ended':
      case 'conversation_end':
        this.fireEnded();
        break;
      default:
        break;
    }
  }
}

export class LiveAgentSessionFactory implements AgentSessionFactory {
  constructor(
    private readonly client: ElevenLabsClient,
    private readonly log: Logger,
  ) {}

  async open(params: {
    dynamicVariables: Record<string, string>;
    handlers: AgentSessionHandlers;
  }): Promise<AgentSession> {
    const url = await this.client.getSignedUrl();
    const socket = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });

    return new LiveAgentSession(
      socket,
      params.handlers,
      params.dynamicVariables,
      this.log,
    );
  }
}
