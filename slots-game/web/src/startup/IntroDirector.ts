import type { LaunchScene } from "../renderer/intro/LaunchScene";
import {
  INTRO_CUES,
  INTRO_DURATION_MS,
  REDUCED_INTRO_DURATION_MS,
  introFrameAt,
  reducedIntroFrame,
  type IntroFrame,
} from "./introTimeline";
import {
  browserTimelineClock,
  PRIMAL_SCHEDULER_POLICY,
  Timeline,
  type TimelineClock,
  type TimelineCue,
} from "./Timeline";

/** 由所选网络音频后端提供的只读时钟接口。 */
export interface LaunchPlaybackClock {
  now(): number;
}

/**
 * RAF 仍属于浏览器挂钟，而已用启动时间可以切换到已安排的 AudioContext 时钟（Continue）。切换会保留当前逻辑值，因此恢复或失败都不会跳转预设的转换。
 */
export class SwitchableLaunchClock implements TimelineClock {
  private source: LaunchPlaybackClock;
  private sourceEpoch: number;
  private logicalEpoch = 0;

  constructor(private readonly wall: TimelineClock = browserTimelineClock) {
    this.source = wall;
    this.sourceEpoch = wall.now();
  }

  now(): number {
    return this.logicalEpoch + Math.max(0, this.source.now() - this.sourceEpoch);
  }

  requestFrame(callback: (time: number) => void): number {
    return this.wall.requestFrame(() => callback(this.now()));
  }

  cancelFrame(handle: number): void {
    this.wall.cancelFrame(handle);
  }

  follow(source: LaunchPlaybackClock): void {
    this.switchSource(source);
  }

  followWall(): void {
    this.switchSource(this.wall);
  }

  /** 将下一个启动序列重置为新的挂钟零纪元。 */
  resetToWall(): void {
    this.source = this.wall;
    this.sourceEpoch = this.wall.now();
    this.logicalEpoch = 0;
  }

  private switchSource(source: LaunchPlaybackClock): void {
    const logicalNow = this.now();
    this.source = source;
    this.sourceEpoch = source.now();
    this.logicalEpoch = logicalNow;
  }
}

export interface IntroDirectorOptions {
  clock?: TimelineClock;
  /** 共享外部播放时钟已经应用了自己的暂停时期。 */
  clockOwnsElapsedTime?: boolean;
  reducedMotion?: boolean;
  onFrame?(frame: IntroFrame, timeMs: number): void;
  onCue?(cue: TimelineCue): void;
  onComplete?(result: IntroCompletion): void;
}

export interface IntroCompletion {
  readonly skipped: boolean;
  readonly reducedMotion: boolean;
}

export class IntroDirector {
  private timeline: Timeline | null = null;
  private skipped = false;
  private completionNotified = false;
  private destroyed = false;

  constructor(
    private readonly scene: LaunchScene,
    private readonly options: IntroDirectorOptions = {},
  ) {}

  play(): Promise<void> {
    if (this.timeline) return this.timeline.play();
    const reducedMotion = this.options.reducedMotion ?? false;
    const durationMs = reducedMotion ? REDUCED_INTRO_DURATION_MS : INTRO_DURATION_MS;
    // 减少动作只会缩短视觉编排。捕获的 GameTransition 声音在原始捆绑包中没有缩减运动门。
    const cues = reducedMotion
      ? INTRO_CUES.filter(({ name }) => name === "audio.game-intro")
      : INTRO_CUES;
    this.timeline = new Timeline({
      durationMs,
      cues,
      clock: this.options.clock,
      scheduler: this.options.clockOwnsElapsedTime ? undefined : PRIMAL_SCHEDULER_POLICY,
      onFrame: (timeMs) => {
        const frame = reducedMotion
          ? reducedIntroFrame(timeMs / REDUCED_INTRO_DURATION_MS)
          : introFrameAt(timeMs);
        this.scene.applyFrame(frame);
        this.options.onFrame?.(frame, timeMs);
      },
      onCue: this.options.onCue,
    });
    const completion = this.timeline.play();
    void completion.then(() => this.notifyComplete(), () => undefined);
    return completion;
  }

  skip(): void {
    if (this.completionNotified) return;
    this.skipped = true;
    this.timeline?.skip();
    this.notifyComplete();
  }

  destroy(): void {
    this.destroyed = true;
    this.timeline?.destroy();
  }

  private notifyComplete(): void {
    if (this.destroyed || this.completionNotified) return;
    this.completionNotified = true;
    this.options.onComplete?.({
      skipped: this.skipped,
      reducedMotion: this.options.reducedMotion ?? false,
    });
  }
}
