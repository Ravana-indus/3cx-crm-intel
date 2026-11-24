import type { Logger } from '../util/logger.js';

interface LoopHandle {
  name: string;
  timer: NodeJS.Timeout | null;
}

/**
 * Each loop reschedules itself only after the previous run finishes, so a slow
 * poll can never overlap the next one. Timers are unref'd so they do not keep
 * the process alive on shutdown.
 */
export class Scheduler {
  private readonly loops = new Map<string, LoopHandle>();
  private stopped = false;

  constructor(private readonly log: Logger) {}

  every(name: string, intervalMs: number, run: () => Promise<void>): void {
    if (this.loops.has(name)) return;
    const handle: LoopHandle = { name, timer: null };
    this.loops.set(name, handle);

    const tick = async (): Promise<void> => {
      if (this.stopped) return;

      try {
        await run();
      } catch (error) {
        this.log.error(
          { loop: name, error: error instanceof Error ? error.message : String(error) },
          'scheduled loop failed',
        );
      }

      if (this.stopped) return;

      const jitter = Math.floor(intervalMs * 0.1 * Math.random());
      const timer = setTimeout(() => {
        void tick();
      }, intervalMs + jitter);
      timer.unref();
      handle.timer = timer;
    };

    const initial = setTimeout(() => {
      void tick();
    }, 500);
    initial.unref();
    handle.timer = initial;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const handle of this.loops.values()) {
      if (handle.timer) clearTimeout(handle.timer);
    }
    this.loops.clear();
  }
}
