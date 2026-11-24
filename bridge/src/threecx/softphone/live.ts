import type { Page } from 'playwright';
import type { Config } from '../../config.js';
import type { Logger } from '../../util/logger.js';
import { ThreeCXSession } from '../live/session.js';
import type {
  AudioTransport,
  IncomingCall,
  SoftphoneStatus,
  ThreeCXSoftphone,
} from './types.js';

/**
 * Selectors are recon-dependent. Fill them from the Phase 0 HAR / DOM dump of
 * the 3CX web client's softphone.
 */
export const SOFTPHONE_SELECTORS = {
  statusButton:
    '[data-testid="status-button"], .status-selector, button[aria-label*="status" i]',
  dndOption: 'text=/Do Not Disturb|DND/i',
  availableOption: 'text=/^Available$/i',
  answer: 'button:has-text("Answer"), button[aria-label*="answer" i]',
  hangup:
    'button:has-text("Hang up"), button:has-text("End call"), button[aria-label*="hang" i]',
  ringing: 'text=/Incoming call|Ringing/i',
  caller: '[data-testid="caller-id"], .caller-id, .caller-number',
};

/**
 * Installs a fake microphone (agent audio in) and taps the remote audio track
 * (caller audio out). PCM is 16 kHz mono, matching ElevenLabs pcm_16000.
 */
const AUDIO_HOOKS = `
(() => {
  if (window.__bridgeAudioInstalled) return;
  window.__bridgeAudioInstalled = true;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: 16000 });
  const destination = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 1;
  gain.connect(destination);

  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.audio) return destination.stream;
    return originalGetUserMedia(constraints);
  };

  const sources = new Set();
  window.__bridgePlay = (base64) => {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const pcm = new Int16Array(bytes.buffer);
      const buffer = ctx.createBuffer(1, pcm.length, 16000);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => sources.delete(source);
      sources.add(source);
      source.start();
    } catch (error) {
      // ignore individual chunk failures
    }
  };

  window.__bridgeFlush = () => {
    for (const source of sources) {
      try { source.stop(); } catch (error) {}
    }
    sources.clear();
  };

  const OriginalPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new OriginalPeerConnection(...args);
    pc.addEventListener('track', (event) => {
      if (!event.track || event.track.kind !== 'audio') return;
      try {
        const stream = new MediaStream([event.track]);
        const source = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        source.connect(node);
        node.connect(ctx.destination);
        node.onaudioprocess = (audioEvent) => {
          const input = audioEvent.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i += 1) {
            const sample = Math.max(-1, Math.min(1, input[i]));
            pcm[i] = sample * 32767;
          }
          const bytes = new Uint8Array(pcm.buffer);
          let binary = '';
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
          }
          window.__bridgeSendPcm(btoa(binary));
        };
      } catch (error) {
        // ignore
      }
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = OriginalPeerConnection.prototype;
})();
`;

class LiveAudioTransport implements AudioTransport {
  constructor(
    private readonly page: Page,
    private readonly log: Logger,
    private readonly bindSink: (sink: ((pcm: Buffer) => void) | null) => void,
  ) {}

  async start(): Promise<void> {
    await this.page.evaluate(AUDIO_HOOKS);
    const installed = await this.page.evaluate(
      () =>
        (globalThis as unknown as { __bridgeAudioInstalled?: boolean })
          .__bridgeAudioInstalled === true,
    );
    if (!installed) throw new Error('audio hooks did not install');
  }

  onCallerAudio(cb: (pcm: Buffer) => void): void {
    this.bindSink(cb);
  }

  sendAgentAudio(pcm: Buffer): void {
    this.page
      .evaluate(
        (base64) =>
          (
            globalThis as unknown as { __bridgePlay?: (value: string) => void }
          ).__bridgePlay?.(base64),
        pcm.toString('base64'),
      )
      .catch((error) => this.log.debug({ error: String(error) }, 'playback chunk failed'));
  }

  flushPlayback(): void {
    this.page
      .evaluate(() =>
        (globalThis as unknown as { __bridgeFlush?: () => void }).__bridgeFlush?.(),
      )
      .catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.bindSink(null);
    this.flushPlayback();
  }
}

export class LiveSoftphone implements ThreeCXSoftphone {
  readonly mode = 'live' as const;
  private page: Page | null = null;
  private incomingHandler: ((call: IncomingCall) => void) | null = null;
  private endedHandler: ((callId: string) => void) | null = null;
  private callerSink: ((pcm: Buffer) => void) | null = null;
  private watcher: NodeJS.Timeout | null = null;
  private activeCall: IncomingCall | null = null;
  private bindingReady = false;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly session: ThreeCXSession,
  ) {}

  async ensureReady(): Promise<void> {
    await this.session.ensureAuth();
    this.page = await this.session.getPage();

    const context = this.session.getContext();
    if (context && !this.bindingReady) {
      try {
        await context.exposeBinding('__bridgeSendPcm', (_source, payload) => {
          this.callerSink?.(Buffer.from(String(payload), 'base64'));
        });
      } catch (error) {
        this.log.debug({ error: String(error) }, 'audio binding already exposed');
      }
      this.bindingReady = true;
    }

    if (!this.watcher) {
      this.watcher = setInterval(() => {
        void this.pollCallState();
      }, 2_000);
      this.watcher.unref();
    }
  }

  async setStatus(status: SoftphoneStatus): Promise<void> {
    const page = this.requirePage();
    try {
      await page.locator(SOFTPHONE_SELECTORS.statusButton).first().click({ timeout: 5_000 });
      const option =
        status === 'dnd'
          ? SOFTPHONE_SELECTORS.dndOption
          : SOFTPHONE_SELECTORS.availableOption;
      await page.locator(option).first().click({ timeout: 5_000 });
    } catch (error) {
      this.log.warn(
        { status, error: String(error) },
        'could not change extension status; check softphone selectors',
      );
      throw error;
    }
  }

  async answer(callId: string): Promise<void> {
    const page = this.requirePage();
    await page.locator(SOFTPHONE_SELECTORS.answer).first().click({ timeout: 10_000 });
    this.log.info({ callId }, 'answered AI call in web client');
  }

  async hangup(callId: string): Promise<void> {
    const page = this.requirePage();
    await page
      .locator(SOFTPHONE_SELECTORS.hangup)
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    this.log.info({ callId }, 'hung up AI call in web client');
  }

  onIncomingCall(cb: (call: IncomingCall) => void): void {
    this.incomingHandler = cb;
  }

  onCallEnded(cb: (callId: string) => void): void {
    this.endedHandler = cb;
  }

  async createTransport(): Promise<AudioTransport> {
    const page = this.requirePage();
    return new LiveAudioTransport(page, this.log, (sink) => {
      this.callerSink = sink;
    });
  }

  async close(): Promise<void> {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
    await this.session.close();
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('softphone not ready; call ensureReady() first');
    return this.page;
  }

  private async pollCallState(): Promise<void> {
    if (!this.page) return;

    const ringing = await this.page
      .locator(SOFTPHONE_SELECTORS.ringing)
      .first()
      .isVisible()
      .catch(() => false);

    if (ringing && !this.activeCall) {
      const callerText = await this.page
        .locator(SOFTPHONE_SELECTORS.caller)
        .first()
        .textContent()
        .catch(() => '');
      const call: IncomingCall = {
        callId: `live-${Date.now()}`,
        fromRaw: (callerText ?? '').trim(),
        startedAt: new Date().toISOString(),
      };
      this.activeCall = call;
      this.incomingHandler?.(call);
      return;
    }

    if (!ringing && this.activeCall) {
      const callId = this.activeCall.callId;
      this.activeCall = null;
      this.endedHandler?.(callId);
    }
  }
}
