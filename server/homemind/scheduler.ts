/**
 * The tick loop: one per process, every 5 seconds.
 *
 * Kept on `globalThis`, so a Vite reload of the bridge module swaps in the new task instead of
 * starting a second loop. A tick never overlaps the previous one, and a failing tick is logged and the
 * loop goes on. The timer does not keep the process alive. No other I/O.
 */

export const TICK_MS = 5000;

type Task = () => Promise<void> | void;

interface Holder {
  timer: ReturnType<typeof setInterval>;
  intervalMs: number;
  task: Task;
  running: boolean;
}

const KEY = Symbol.for('homemind.scheduler');
type GlobalWithScheduler = typeof globalThis & { [KEY]?: Holder };

async function runOnce(holder: Holder): Promise<void> {
  if (holder.running) return;
  holder.running = true;
  try {
    await holder.task();
  } catch (error) {
    console.error('[homemind] tick failed:', error instanceof Error ? error.message : 'unknown error');
  } finally {
    holder.running = false;
  }
}

/** Starts the loop, or gives the running loop a new task. Only one timer ever runs. */
export function startScheduler(task: Task, intervalMs: number = TICK_MS): void {
  const g = globalThis as GlobalWithScheduler;
  const existing = g[KEY];
  if (existing && existing.intervalMs === intervalMs) {
    existing.task = task;
    return;
  }
  if (existing) clearInterval(existing.timer);
  const holder: Holder = { task, intervalMs, running: false, timer: undefined as unknown as ReturnType<typeof setInterval> };
  holder.timer = setInterval(() => void runOnce(holder), intervalMs);
  (holder.timer as { unref?: () => void }).unref?.();
  g[KEY] = holder;
}

export function stopScheduler(): void {
  const g = globalThis as GlobalWithScheduler;
  const holder = g[KEY];
  if (holder) clearInterval(holder.timer);
  delete g[KEY];
}

export function schedulerRunning(): boolean {
  return !!(globalThis as GlobalWithScheduler)[KEY];
}

/** Runs the current task now (not overlapping a running tick). For the demo clock and tests. */
export function tickSchedulerNow(): Promise<void> {
  const holder = (globalThis as GlobalWithScheduler)[KEY];
  return holder ? runOnce(holder) : Promise.resolve();
}
