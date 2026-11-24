import type { Config } from '../config.js';
import type { ElevenLabsClient } from '../elevenlabs/types.js';
import type { AgentSession, AgentSessionFactory, ClientToolCall } from '../elevenlabs/types.js';
import type { AiConversationsRepo } from '../repo/aiConversations.js';
import type { CallsRepo } from '../repo/calls.js';
import type { OutboxRepo } from '../repo/outbox.js';
import type { PortalClient, PortalLead } from '../portal/client.js';
import type {
  AudioTransport,
  IncomingCall,
  ThreeCXSoftphone,
} from '../threecx/softphone/types.js';
import type { Logger } from '../util/logger.js';
import { normalisePhone } from '../util/phone.js';

type Alerter = (event: string, detail: unknown) => Promise<void>;

export interface VoiceBridgeDeps {
  config: Config;
  log: Logger;
  softphone: ThreeCXSoftphone;
  sessions: AgentSessionFactory;
  elevenlabs: ElevenLabsClient;
  portal: PortalClient;
  calls: CallsRepo;
  aiConversations: AiConversationsRepo;
  outbox: OutboxRepo;
  alert?: Alerter;
}

interface ActiveCall {
  call: IncomingCall;
  callerE164: string | null;
  startedAtIso: string;
  lead: PortalLead | null;
  session: AgentSession;
  transport: AudioTransport;
  lastAudioAt: number;
  transcripts: Array<{ speaker: string; text: string }>;
  ended: boolean;
  finalizing: boolean;
}

/**
 * Wires one 3CX AI-extension call to one ElevenLabs conversation. One live call
 * per AI extension, matching the browser softphone's limit.
 */
export class VoiceBridge {
  private active: ActiveCall | null = null;

  constructor(private readonly deps: VoiceBridgeDeps) {}

  start(): void {
    this.deps.softphone.onIncomingCall((call) => {
      void this.handleIncoming(call);
    });
    this.deps.softphone.onCallEnded((callId) => {
      void this.handleCallEnded(callId);
    });
  }

  async handleIncoming(call: IncomingCall): Promise<void> {
    const { config, log, softphone, sessions, portal } = this.deps;

    if (this.active) {
      log.warn(
        { callId: call.callId },
        'second AI call while one is live; 3CX should have used voicemail',
      );
      return;
    }

    const phone = normalisePhone(call.fromRaw);
    const callerE164 = phone.e164 ?? call.fromE164 ?? null;
    const lead = callerE164 ? await portal.lookupLead(callerE164) : null;

    const transport = await softphone.createTransport();
    await transport.start();

    let state: ActiveCall;

    const session = await sessions.open({
      dynamicVariables: {
        caller_number: callerE164 ?? call.fromRaw,
        lead_name: lead?.name ?? '',
        case_stage: lead?.stage ?? '',
      },
      handlers: {
        onAgentAudio: (pcm) => {
          state.lastAudioAt = Date.now();
          transport.sendAgentAudio(pcm);
        },
        onInterruption: () => transport.flushPlayback(),
        onToolCall: (toolCall) => {
          void this.handleToolCall(state, toolCall);
        },
        onTranscript: (entry) => {
          state.lastAudioAt = Date.now();
          state.transcripts.push(entry);
        },
        onEnded: () => {
          void this.handleSessionEnded(state);
        },
      },
    });

    state = {
      call,
      callerE164,
      startedAtIso: call.startedAt ?? new Date().toISOString(),
      lead,
      session,
      transport,
      lastAudioAt: Date.now(),
      transcripts: [],
      ended: false,
      finalizing: false,
    };
    this.active = state;

    transport.onCallerAudio((pcm) => {
      state.lastAudioAt = Date.now();
      session.sendCallerAudio(pcm);
    });

    await softphone.answer(call.callId);
    log.info(
      {
        callId: call.callId,
        caller: callerE164,
        leadId: lead?.lead_id ?? null,
        aiMode: config.aiMode,
      },
      'AI call started',
    );
  }

  /** Called by the scheduler; hangs up a call with no audio in either direction. */
  async tick(now = Date.now()): Promise<void> {
    const state = this.active;
    if (!state || state.ended) return;
    if (now - state.lastAudioAt <= this.deps.config.aiWatchdogMs) return;

    this.deps.log.warn(
      { callId: state.call.callId, silenceMs: now - state.lastAudioAt },
      'AI call watchdog fired',
    );
    await this.emitFailure(state, 'watchdog_no_audio');
    await this.endCall(state, 'watchdog_no_audio');
  }

  async stop(): Promise<void> {
    if (this.active) await this.endCall(this.active, 'bridge_shutdown');
    await this.deps.softphone.close();
  }

  private async handleToolCall(
    state: ActiveCall,
    toolCall: ClientToolCall,
  ): Promise<void> {
    const { portal, log } = this.deps;

    try {
      switch (toolCall.toolName) {
        case 'end_call': {
          state.session.sendToolResult(toolCall.toolCallId, { ok: true });
          await this.endCall(state, 'agent_end_call');
          return;
        }
        case 'lookup_caller': {
          const e164 = String(
            toolCall.parameters.e164 ??
              toolCall.parameters.phone ??
              state.callerE164 ??
              '',
          );
          const lead = e164 ? await portal.lookupLead(e164) : null;
          if (lead?.lead_id) state.lead = lead;
          state.session.sendToolResult(toolCall.toolCallId, lead ?? { lead_id: null });
          return;
        }
        case 'create_enquiry':
        case 'request_callback': {
          const result = await portal.createEnquiry({
            ...toolCall.parameters,
            type:
              toolCall.toolName === 'request_callback'
                ? 'callback'
                : 'enquiry',
            caller_number: state.callerE164,
            call_id: state.call.callId,
            lead_id: state.lead?.lead_id ?? null,
          });
          state.session.sendToolResult(toolCall.toolCallId, result);
          return;
        }
        default: {
          log.warn({ tool: toolCall.toolName }, 'unknown AI client tool');
          state.session.sendToolResult(
            toolCall.toolCallId,
            { error: `unknown tool ${toolCall.toolName}` },
            true,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.session.sendToolResult(toolCall.toolCallId, { error: message }, true);
    }
  }

  private async handleCallEnded(callId: string): Promise<void> {
    if (this.active?.call.callId === callId) {
      await this.endCall(this.active, 'caller_hangup');
    }
  }

  private async handleSessionEnded(state: ActiveCall): Promise<void> {
    if (state.ended || state.finalizing) return;
    await this.endCall(state, 'session_ended', true);
  }

  private async endCall(
    state: ActiveCall,
    reason: string,
    sessionAlreadyClosed = false,
  ): Promise<void> {
    if (state.finalizing) return;
    state.finalizing = true;

    if (!state.ended) {
      state.ended = true;
      await this.deps.softphone
        .hangup(state.call.callId)
        .catch((error) =>
          this.deps.log.warn({ error: String(error) }, 'hangup failed'),
        );
    }

    if (!sessionAlreadyClosed) {
      await state.session.close().catch(() => undefined);
    }
    await state.transport.stop().catch(() => undefined);

    if (this.active === state) this.active = null;
    await this.finalize(state, reason);
  }

  private async finalize(state: ActiveCall, reason: string): Promise<void> {
    const { config, log, elevenlabs, calls, aiConversations, outbox } =
      this.deps;
    const conversationId = state.session.conversationId;

    try {
      const data = conversationId
        ? await elevenlabs.getConversation(conversationId)
        : null;

      const callRow = config.tcxAiExt
        ? calls.findByExtAndTime(config.tcxAiExt, state.startedAtIso, 120)
        : undefined;
      const leadId = state.lead?.lead_id ?? null;

      if (conversationId) {
        aiConversations.upsert({
          elConversationId: conversationId,
          callId: callRow?.id ?? null,
          callerE164: state.callerE164,
          transcript: data?.transcript ?? state.transcripts,
          analysis: data?.analysis ?? null,
          collected: data?.collected ?? null,
          leadId,
        });
      }

      outbox.enqueue('ai.conversation.completed', {
        event: 'ai.conversation.completed',
        conversation: {
          id: conversationId,
          call_id: callRow?.id ?? null,
          caller: state.callerE164,
          lead_id: leadId,
          reason,
          analysis: data?.analysis ?? null,
          collected: data?.collected ?? null,
        },
      });

      log.info(
        { conversationId, callId: callRow?.id ?? null, reason },
        'AI conversation completed',
      );
    } catch (error) {
      log.error(
        { conversationId, error: String(error) },
        'failed to store AI conversation analysis',
      );
      await this.emitFailure(
        state,
        `analysis_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async emitFailure(state: ActiveCall, reason: string): Promise<void> {
    const detail = {
      event: 'ai.call_failed',
      call_id: state.call.callId,
      caller: state.callerE164,
      reason,
    };

    this.deps.outbox.enqueue('ai.call_failed', detail);
    await this.deps.alert?.('ai.call_failed', detail).catch(() => undefined);
  }
}
