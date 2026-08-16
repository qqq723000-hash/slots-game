export interface TimelineClock {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(handle: number): void;
}

export interface TimelineCue {
  name: string;
  atMs: number;
}

export interface TimelineOptions {
  durationMs: number;
  cues?: readonly TimelineCue[];
  clock?: TimelineClock;
  scheduler?: TimelineSchedulerPolicy;
  onFrame(timeMs: number): void;
  onCue?(cue: TimelineCue): void;
}

export interface TimelineSchedulerPolicy {
  readonly fps: number;
  readonly maxCatchUpTicks: number;
}

/** 捕获的 Play'n GO 运行时使用的调度程序值。 */
export const PRIMAL_SCHEDULER_POLICY = Object.freeze({
  fps: 30,
  maxCatchUpTicks: 5,
} satisfies TimelineSchedulerPolicy);

export const PRIMAL_SCHEDULER_MAX_CATCH_UP_MS = (
  PRIMAL_SCHEDULER_POLICY.maxCatchUpTicks / PRIMAL_SCHEDULER_POLICY.fps
) * 1_000;

export const browserTimelineClock: TimelineClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

/** 使用小的确定性时间线而不是引入第二个动画运行时。 */
export class Timeline {
  private readonly durationMs: number;
  private readonly cues: readonly TimelineCue[];
  private readonly clock: TimelineClock;
  private readonly scheduler: TimelineSchedulerPolicy | null;
  private readonly onFrame: (timeMs: number) => void;
  private readonly onCue?: (cue: TimelineCue) => void;
  private startedAt = 0;
  private schedulerTickCount = 0;
  private frameHandle: number | null = null;
  private cueIndex = 0;
  private state: "idle" | "running" | "complete" | "failed" = "idle";
  private completion: Promise<void> | null = null;
  private resolveCompletion: (() => void) | null = null;
  private rejectCompletion: ((reason?: unknown) => void) | null = null;

  constructor(options: TimelineOptions) {
    if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
      throw new Error("Timeline duration must be positive");
    }
    this.durationMs = options.durationMs;
    this.cues = [...(options.cues ?? [])].sort((left, right) => left.atMs - right.atMs);
    this.clock = options.clock ?? browserTimelineClock;
    this.scheduler = options.scheduler ?? null;
    if (this.scheduler && (
      !Number.isFinite(this.scheduler.fps)
      || this.scheduler.fps <= 0
      || !Number.isInteger(this.scheduler.maxCatchUpTicks)
      || this.scheduler.maxCatchUpTicks <= 0
    )) {
      throw new Error("Timeline scheduler policy must use a positive fps and tick limit");
    }
    this.onFrame = options.onFrame;
    this.onCue = options.onCue;
  }

  play(): Promise<void> {
    if (this.completion) return this.completion;
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.state = "running";
    try {
      this.startedAt = this.clock.now();
      this.schedulerTickCount = 0;
      this.apply(0, true);
      this.frameHandle = this.clock.requestFrame(this.tick);
    } catch (error) {
      this.fail(error);
    }
    return this.completion;
  }

  skip(): void {
    if (this.state === "complete" || this.state === "failed") return;
    if (!this.completion) this.play();
    if (this.state !== "running") return;
    this.cancelScheduledFrame();
    this.cueIndex = this.cues.length;
    try {
      this.onFrame(this.durationMs);
      this.finish();
    } catch (error) {
      this.fail(error);
    }
  }

  destroy(): void {
    if (this.state === "idle" || this.state === "running") this.skip();
  }

  private readonly tick = (time: number): void => {
    if (this.state !== "running") return;
    try {
      const elapsed = Math.min(this.durationMs, this.schedulerElapsedAt(time));
      this.apply(elapsed, false);
      if (elapsed >= this.durationMs) {
        this.finish();
        return;
      }
      this.frameHandle = this.clock.requestFrame(this.tick);
    } catch (error) {
      this.fail(error);
    }
  };

  /**
   * 镜像官方 30 fps Scheduler 更新程序。停滞的 RAF 最多可以处理 5 个挂起的报价单；然后，它的纪元被重新调整，
   * 因此隐藏选项卡和第一帧停顿无法跳过整个墙壁间隙的 Spine 时间线。
   */
  private schedulerElapsedAt(time: number): number {
    const policy = this.scheduler;
    if (!policy) return Math.max(0, time - this.startedAt);

    const tickMs = 1_000 / policy.fps;
    let targetTick = ((time - this.startedAt) * policy.fps) / 1_000;
    if (targetTick < this.schedulerTickCount - 1) {
      targetTick = this.schedulerTickCount;
      this.startedAt = time - targetTick * tickMs;
    } else if (targetTick - this.schedulerTickCount > policy.maxCatchUpTicks) {
      targetTick = this.schedulerTickCount + policy.maxCatchUpTicks;
      this.startedAt = time - targetTick * tickMs;
    }
    while (this.schedulerTickCount < targetTick) this.schedulerTickCount += 1;
    return Math.max(0, time - this.startedAt);
  }

  private apply(timeMs: number, includeZeroCues: boolean): void {
    this.onFrame(timeMs);
    while (this.cueIndex < this.cues.length) {
      const cue = this.cues[this.cueIndex];
      if (!cue || cue.atMs > timeMs || (!includeZeroCues && timeMs === 0)) break;
      this.cueIndex += 1;
      this.onCue?.(cue);
    }
  }

  private finish(): void {
    this.state = "complete";
    this.frameHandle = null;
    const resolve = this.resolveCompletion;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
    resolve?.();
  }

  private fail(error: unknown): void {
    this.state = "failed";
    this.cancelScheduledFrame();
    const reject = this.rejectCompletion;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
    reject?.(error);
  }

  private cancelScheduledFrame(): void {
    if (this.frameHandle === null) return;
    this.clock.cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }
}
