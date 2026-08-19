/**
 * Wall-clock stopwatch for the phase timings the resolve, render, and routing pipelines report.
 *
 * The clock starts at construction and restarts on every `mark`, so a straight-line sequence of
 * `mark(name)` calls carves the run into back-to-back spans keyed by name. `reset` drops the span
 * in flight (for stretches that should not be billed to any phase, such as waiting on a pool), and
 * `merge` folds a nested pipeline's record in under a prefix. `totalMs` reads a separate
 * construction-time anchor that the span clock never disturbs. Values are milliseconds rounded to
 * two decimals; `timings` is the live record that callers attach to their result.
 */
export class TimeTracker {
  private readonly record: Record<string, number> = {};
  private readonly createdAt: number = performance.now();
  private startedAt: number = performance.now();

  /** Accumulated phase timings in milliseconds, in the order they were marked. */
  get timings(): Record<string, number> {
    return this.record;
  }

  /** Records the span since construction, the last `mark`, or the last `reset`, then restarts. */
  mark(name: string): void {
    const now = performance.now();
    this.record[name] = Math.round((now - this.startedAt) * 100) / 100;
    this.startedAt = now;
  }

  /**
   * Wall-clock milliseconds since the tracker was constructed, rounded to two decimals.
   *
   * Anchored at construction rather than at the phase clock, so `mark` and `reset` leave it
   * untouched: callers report it as the run total alongside the per-phase spans.
   */
  totalMs(): number {
    return Math.round((performance.now() - this.createdAt) * 100) / 100;
  }

  /** Restarts the clock without recording the span in flight. */
  reset(): void {
    this.startedAt = performance.now();
  }

  /** Folds another pipeline's timings in under `${prefix}.${stage}` keys. */
  merge(prefix: string, timings: Record<string, number> | undefined): void {
    for (const [stage, ms] of Object.entries(timings ?? {})) {
      this.record[`${prefix}.${stage}`] = ms;
    }
  }
}
