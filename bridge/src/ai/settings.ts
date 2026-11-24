import type { SettingsRepo } from '../repo/settings.js';
import type {
  SoftphoneStatus,
  ThreeCXSoftphone,
} from '../threecx/softphone/types.js';
import type { Logger } from '../util/logger.js';

export type AiMode = 'off' | 'overflow' | 'always';

export interface AiSettings {
  mode: AiMode;
  schedule: string | null;
}

const MODES: AiMode[] = ['off', 'overflow', 'always'];

function isMode(value: string | null): value is AiMode {
  return value !== null && MODES.includes(value as AiMode);
}

/**
 * off   -> extension 199 in Do Not Disturb, 3CX skips it
 * overflow/always -> extension 199 available, 3CX routes as configured
 */
export class AiSettingsService {
  constructor(
    private readonly settings: SettingsRepo,
    private readonly softphone: ThreeCXSoftphone,
    private readonly defaultMode: AiMode,
    private readonly log: Logger,
  ) {}

  get(): AiSettings {
    const stored = this.settings.get('ai_mode');
    const schedule = this.settings.get('ai_schedule');
    return {
      mode: isMode(stored) ? stored : this.defaultMode,
      schedule: schedule && schedule.trim() !== '' ? schedule : null,
    };
  }

  async set(input: {
    mode?: AiMode;
    schedule?: string | null;
  }): Promise<AiSettings> {
    if (input.schedule !== undefined) {
      this.settings.set('ai_schedule', input.schedule ?? '');
    }

    if (input.mode) {
      this.settings.set('ai_mode', input.mode);
      await this.apply(input.mode);
    }

    return this.get();
  }

  async applyCurrent(): Promise<void> {
    await this.apply(this.get().mode);
  }

  private async apply(mode: AiMode): Promise<void> {
    const status: SoftphoneStatus = mode === 'off' ? 'dnd' : 'available';
    try {
      await this.softphone.ensureReady();
      await this.softphone.setStatus(status);
    } catch (error) {
      this.log.warn(
        { mode, status, error: String(error) },
        'could not apply AI mode to extension; check softphone selectors',
      );
    }
  }
}
