import type { CellAddress, GridCell } from "../app/state/types";
import {
  PRIMAL_FAST_REEL_SETTLE_MS,
  PRIMAL_REEL_ANTICIPATION_TRANSITION_MS,
  PRIMAL_REEL_IMPACT_PROGRESS,
  PRIMAL_REEL_TIMING_MS,
} from "./primalAnimationTiming";
import { reelStopMotionConfig, type ReelStopMode } from "./reelMotion";
import { createStopPlan, type StopPlanOptions } from "./stopPlanner";

export const REEL_IMPACT_PROGRESS = PRIMAL_REEL_IMPACT_PROGRESS;

/**
 * 复刻 `Cg(15, [0, 1, 2], 2, 3)` 的悬念处理参数。当前两个转轴都包含 Rage/SURGE 符号时，第三个转轴会执行持续三秒的 SLOW 停轴；
 * 它自己的结果从不参与门。
 *
 * 英文 / English: Replicate the suspense handling parameters of `Cg(15, [0, 1, 2], 2, 3)`. When the first two reels contain the Rage/SURGE symbol, the third reel performs a SLOW that lasts three seconds; its own results never participate in the gate.
 */
export const PRIMAL_ANTICIPATION_SLOW_STOP_MS = 3_000;
/** @deprecated Kept 用于源兼容性；这是 SLOW 停止持续时间，而不是释放延迟。 / English: @deprecated Kept is for source compatibility; this is the SLOW stop duration, not the release delay. */
export const PRIMAL_ANTICIPATION_RELEASE_DELAY_MS = PRIMAL_ANTICIPATION_SLOW_STOP_MS;
/** 制作好的隐藏片段到达隐藏姿态前的一帧，帧率为 30fps。 / English: The frame rate of the produced hidden clip is 30fps, one frame before it reaches the hidden pose. */
export const PRIMAL_ANTICIPATION_COPY_CLEAR_LEAD_MS = 1_000 / 30;
export const PRIMAL_ANTICIPATION_REEL = 2 as const;
export const PRIMAL_ANTICIPATION_TRIGGER_REELS = Object.freeze([0, 1] as const);
/** GameReelLogicController.stopOutroHandler 为倍率揭示保留的制作时长。 / English: GameReelLogicController.stopOutroHandler The duration of production reserved for override reveals. */
export const PRIMAL_WILD_REVEAL_OUTRO_MS = 1_000;
/** GameReelLogicController.stopOutroHandler的三Rage激活保持。 / English: The triple Rage activation of GameReelLogicController.stopOutroHandler remains. */
export const PRIMAL_SURGE_ACTIVATION_OUTRO_MS = 1_250;

export interface AnticipationTriggerPlan {
  readonly reel: typeof PRIMAL_ANTICIPATION_REEL;
  readonly triggerReels: typeof PRIMAL_ANTICIPATION_TRIGGER_REELS;
  /** 第三个转轴持续 SLOW 停轴的时长。 / English: The third reel lasts for the duration of SLOW. */
  readonly slowStopMs: typeof PRIMAL_ANTICIPATION_SLOW_STOP_MS;
}

/**
 * 从原始停止处理程序中恢复的纯粹的、保留权威的预期门。它检查已确定的网格但从不更改它。
 *
 * 英文 / English: A pure, authority-preserving expectation gate restored from the original stop handler. It checks the determined grid but never changes it.
 */
export function createAnticipationTriggerPlan(
  grid: readonly (readonly GridCell[])[],
): AnticipationTriggerPlan | null {
  if (grid.length < 3) return null;
  const hasSurge = (reel: readonly GridCell[] | undefined): boolean =>
    reel?.some((cell) => cell.symbol === "SURGE") ?? false;
  if (!hasSurge(grid[0]) || !hasSurge(grid[1])) return null;
  return Object.freeze({
    reel: PRIMAL_ANTICIPATION_REEL,
    triggerReels: PRIMAL_ANTICIPATION_TRIGGER_REELS,
    slowStopMs: PRIMAL_ANTICIPATION_SLOW_STOP_MS,
  });
}

export type PostStopActivationKind = "wild-reveal" | "surge-feature-activation";

/**
 * 只读停止结尾决定。 Wild 显示与捕获的控制器具有相同的独占优先级：合格的 Wild 会抑制此屏障的三 Rage 激活分支，而不更改任何权威单元。
 *
 * 英文 / English: Read only stops ending decision. Wilds appear to have the same exclusive priority as captured controllers: a qualifying Wild suppresses the three-Rage activation branch of this barrier without changing any authority units.
 */
export interface PostStopActivationPlan {
  readonly kind: PostStopActivationKind;
  readonly cells: readonly Readonly<CellAddress>[];
  readonly delayMs: number;
}

export function createPostStopActivationPlan(
  grid: readonly (readonly GridCell[])[],
): PostStopActivationPlan | null {
  const wilds: CellAddress[] = [];
  const surges: CellAddress[] = [];
  grid.forEach((reel, reelIndex) => reel.forEach((cell, row) => {
    if (cell.symbol === "WILD" && cell.multiplier !== undefined && cell.multiplier >= 2) {
      wilds.push({ reel: reelIndex, row });
    }
    if (cell.symbol === "SURGE") surges.push({ reel: reelIndex, row });
  }));

  const freezeCells = (cells: readonly CellAddress[]): readonly Readonly<CellAddress>[] =>
    Object.freeze(cells.map((cell) => Object.freeze({ ...cell })));
  if (wilds.length > 0) {
    return Object.freeze({
      kind: "wild-reveal",
      cells: freezeCells(wilds),
      delayMs: PRIMAL_WILD_REVEAL_OUTRO_MS,
    });
  }
  if (surges.length === 3) {
    return Object.freeze({
      kind: "surge-feature-activation",
      cells: freezeCells(surges),
      delayMs: PRIMAL_SURGE_ACTIVATION_OUTRO_MS,
    });
  }
  return null;
}

export interface ReelStopTarget {
  setRows(rows: number): void;
  stopReel(
    reel: number,
    cells: GridCell[],
    durationMs: number,
    mode?: ReelStopMode,
  ): Promise<void>;
  /** 提交 STOPPED/land，同时独立动画弹跳继续。 / English: Submit STOPPED/land while independent animated bounce continues. */
  commitReelImpact?(reel: number, mode: ReelStopMode): void;
  /** 仅启动 stop-outro 分支的符号拥有部分。 / English: Start only the symbol-owning part of the stop-outro branch. */
  playPostStopActivation?(plan: PostStopActivationPlan): void;
  /** 在活动的 SLOW 挑逗期间，下一个用户快速停止到达视图。 / English: During an active SLOW tease, the next user quickly stops arriving in view. */
  requestFastForward?(mode?: ReelStopMode): void;
  cancelPresentation?(): void;
}

export interface ReelImpactEvent {
  readonly reel: number;
  /** 权威格子此时已在这个停稳的转轴上实际可见。 / English: The authority grid is now physically visible on this stopped reel. */
  readonly cells: readonly GridCell[];
  readonly settleMs: number;
  readonly impactMs: number;
  readonly mode: ReelStopMode;
  readonly fastForward: boolean;
}

export interface ReelStopStartEvent extends ReelImpactEvent {}

export interface AllReelsStoppedEvent {
  /** 三个 STOPPED 冲击后的完整权威网格。 / English: Full authority grid after three STOPPED strikes. */
  readonly grid: readonly (readonly GridCell[])[];
  readonly fastForward: boolean;
}

export interface ReelAnticipationStartEvent extends AnticipationTriggerPlan {
  readonly fastForward: false;
}

export type ReelAnticipationStopReason =
  | "reel-impact"
  | "fast-forward"
  | "cancelled"
  | "error"
  | "completed";

export interface ReelAnticipationStopEvent extends AnticipationTriggerPlan {
  readonly fastForward: boolean;
  readonly reason: ReelAnticipationStopReason;
}

export interface ReelAnticipationHideCompleteEvent extends AnticipationTriggerPlan {
  readonly fastForward: false;
}

export interface ReelPostStopActivationEvent extends PostStopActivationPlan {
  /** 当在 ALLSTOPPED 边界之前选择“快速停止”时为真。 / English: True when Quick Stop is selected before the ALLSTOPPED boundary. */
  readonly fastForward: boolean;
}

export interface StopSequencerHooks {
  /**
   * 核心生命周期边界在每个权威卷轴制动之前立即触发。错误会传播，因此严格的状态机违规会中止表现，而不是作为外观故障隐藏。
   *
   * 英文 / English: The core lifetime boundary triggers immediately before each authoritative reel brakes. Errors propagate, so strict state machine violations abort performance rather than hiding as cosmetic failures.
   */
  onReelStopStart?(event: ReelStopStartEvent): void;
  /** 装饰性钩子与转轴的实际撞击点对齐。 / English: The decorative hook is aligned with the actual impact point of the spindle. */
  onReelImpact?(event: ReelImpactEvent): void;
  /** 核心屏障在第三次 STOPPED 冲击时触发，而反弹可能会继续。 / English: The core barrier triggers at the third STOPPED impact, and the rebound is likely to continue. */
  onAllReelsStopped?(event: AllReelsStoppedEvent): void;
  /** 第二个转轴撞击时，开始原生的第三轴悬念表现。 / English: When the second reel hits, the native third axis suspense performance begins. */
  onAnticipationStart?(event: ReelAnticipationStartEvent): void;
  /** 始终在其生命周期结束之前发出积极的预期。 / English: Always emit positive expectations before the end of its life cycle. */
  onAnticipationStop?(event: ReelAnticipationStopEvent): void;
  /**
   * 自然的 SLOW 悬念完成制作好的 333.333ms `hide` 后触发；此接口仅在没有 Wild/三个 Rage 符号负责停轴收尾时生效。
   *
   * 英文 / English: The natural SLOW suspense is triggered after 333.333ms of `hide` is completed; this interface only takes effect when there is no Wild/three Rage symbols responsible for the ending of the axis.
   */
  onAnticipationHideComplete?(event: ReelAnticipationHideCompleteEvent): void;
  /**
   * 制作好的停轴后过渡开始时触发。对于三个 Rage 的悬念表现，在 333.333ms 隐藏栅栏到达 SCATTER_FEATURE_ACTIVATE 前，
   * 它与悬念 `hide` 共用第三轴撞击的同一帧。
   *
   * 英文 / English: Triggered when the transition starts after the axis is stopped. For the suspense performance of three Rage, it shares the same frame of the third axis impact with the suspense `hide` before the hidden fence reaches SCATTER_FEATURE_ACTIVATE at 333.333ms.
   */
  onPostStopTransitionStart?(event: ReelPostStopActivationEvent): void;
  /**
   * 向占领的 SCATTER_FEATURE_ACTIVATE 边界发射。渲染器可能会使用Surge分支来触发ape；和解仍然具有权威性。
   *
   * 英文 / English: Fire towards the occupied SCATTER_FEATURE_ACTIVATE border. The renderer may use the Surge branch to trigger the ape; the reconciliation is still authoritative.
   */
  onPostStopActivation?(event: ReelPostStopActivationEvent): void | Promise<void>;
  /** 在分支的不可跳过的预设停轴结束后被解雇。 / English: Fired at the end of a branch's non-skippable preset stop axis. */
  onPostStopActivationComplete?(event: ReelPostStopActivationEvent): void | Promise<void>;
}

export interface StopPresentationOptions {
  readonly fastPlay?: boolean;
}

export class StopPresentationCancelledError extends Error {
  constructor() {
    super("Reel presentation was cancelled");
    this.name = "StopPresentationCancelledError";
  }
}

export class StopSequencer {
  private presenting = false;
  private fastForwardRequested = false;
  private quickStopReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSlowImpactRelease: (() => void) | null = null;
  private readonly releaseDelays = new Set<{
    readonly finish: () => void;
    readonly fastForwardSkippable: boolean;
  }>();
  private presentationGeneration = 0;
  private spinStartedAtMs: number | null = null;
  private anticipationPlan: AnticipationTriggerPlan | null = null;
  private anticipationActive = false;

  constructor(
    private readonly reels: ReelStopTarget,
    private readonly options: StopPlanOptions = {},
    private readonly hooks: StopSequencerHooks = {},
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** 将 regularSpinTime 锚定到已接受的旋转请求，而不是其响应。 / English: Anchor regularSpinTime to the accepted spin request, not its response. */
  markSpinStart(atMs = this.clock()): void {
    this.clearQuickStopReleaseTimer();
    this.spinStartedAtMs = Number.isFinite(atMs) ? atMs : this.clock();
    this.fastForwardRequested = false;
  }

  /**
   * 仅加速表现。在返回 true 之前，权威网格已经被服务器固定，因此这永远不会改变结算。
   *
   * 英文 / English: Only speeds up performance. The authoritative grid is already pinned by the server before returning true, so this will never change settlement.
   */
  requestFastForward(): boolean {
    // 当服务器响应仍在进行中时收到的 Continue 是正式排队的快速停止。因此，markSpinStart() 是主动圆形栅极，而不是 `presenting`。 / English: A Continue received while the server response is still in progress is a formally queued fast stop. Therefore, markSpinStart() is active circular gate, not `presenting`.
    if (this.spinStartedAtMs === null) return false;
    if (!this.fastForwardRequested) {
      this.fastForwardRequested = true;
      this.scheduleQuickStopRelease();
    }

    // 在用户按下 Continue 之前，悬念处理程序已经消耗了其自己的内部快速停止步骤。因此，下一个用户输入必须立即激活 SLOW 制动器；需要另一次单击比捕获的控制器晚一步。 / English: Before the user presses Continue, the suspense handler has consumed its own internal quick-stop step. Therefore, the next user input must activate the SLOW brake immediately; another click is required one step later than the captured controller.
    if (this.activeSlowImpactRelease) {
      const releaseSlowImpact = this.activeSlowImpactRelease;
      this.stopAnticipation("fast-forward", true);
      this.reels.requestFastForward?.("SLOW");
      releaseSlowImpact();
    }
    return true;
  }

  cancel(): boolean {
    this.clearQuickStopReleaseTimer();
    this.spinStartedAtMs = null;
    if (!this.presenting) {
      this.fastForwardRequested = false;
      return false;
    }
    this.presentationGeneration += 1;
    this.stopAnticipation("cancelled", this.fastForwardRequested);
    this.releasePendingDelays();
    this.reels.cancelPresentation?.();
    return true;
  }

  get isPresenting(): boolean {
    return this.presenting;
  }

  async present(
    grid: GridCell[][],
    presentationOptions: StopPresentationOptions = {},
  ): Promise<void> {
    const rows = grid[0]?.length ?? 0;
    if (grid.length !== 3 || rows < 3 || rows > 8 || grid.some((reel) => reel.length !== rows)) {
      throw new Error("Cannot present malformed server grid");
    }
    if (this.presenting) throw new Error("A reel presentation is already active");

    this.presenting = true;
    if (this.spinStartedAtMs === null) this.spinStartedAtMs = this.clock();
    const fastPlay = presentationOptions.fastPlay === true;
    this.anticipationPlan = fastPlay || this.fastForwardRequested
      ? null
      : createAnticipationTriggerPlan(grid);
    this.anticipationActive = false;
    const generation = ++this.presentationGeneration;
    try {
      this.reels.setRows(rows);
      const plan = createStopPlan(grid.length, fastPlay ? {
        firstDelayMs: this.options.firstDelayMs ?? PRIMAL_REEL_TIMING_MS.fastFirstBrake,
        reelGapMs: this.options.reelGapMs ?? PRIMAL_REEL_TIMING_MS.fastReelGap,
        settleMs: this.options.settleMs ?? PRIMAL_FAST_REEL_SETTLE_MS,
      } : this.options);
      const firstPlannedDelay = plan[0]?.delayMs ?? 0;
      const elapsedSinceSpin = this.spinStartedAtMs === null
        ? 0
        : Math.max(0, this.clock() - this.spinStartedAtMs);
      // 响应迟到时，原始 getStopDelayOffset 只把第一个转轴的时间钳制到“当前时刻”。后续转轴仍保留 300ms 间隔。 / English: When the response is late, the original getStopDelayOffset only clamps the time of the first reel to the "current moment". The 300ms interval remains for subsequent reels.
      const firstPresentationDelay = Math.max(0, firstPlannedDelay - elapsedSinceSpin);
      // 每个计时器都从同一时间原点开始，因此结算动画可以重叠，而转轴启动仍遵循权威的从左到右计划。若依次等待每次结算，会错误地把 settleMs 累加到每个预定的转轴间隔中。 / English: Each timer starts from the same origin in time, so settlement animations can overlap, while reel starts still follow the authoritative left-to-right schedule. Waiting for each settlement in sequence would incorrectly accumulate settleMs for each scheduled reel interval.
      const impactResolvers: Array<() => void> = [];
      const impactBarriers = plan.map((_step, index) => new Promise<void>((resolve) => {
        impactResolvers[index] = resolve;
      }));
      const impactedReels = new Set<number>();
      let allStoppedFired = false;
      let postStopActivation: Promise<void> = Promise.resolve();

      await Promise.all(plan.map(async (step) => {
        const relativeReelDelay = Math.max(0, step.delayMs - firstPlannedDelay);
        await this.wait(firstPresentationDelay + relativeReelDelay);
        if (generation !== this.presentationGeneration) return;

        // 悬念表现和转轴 2 的 SLOW 在转轴 1 进入 STOPPED 时开始，而不是在其回弹后，也不是在虚构的三秒释放延迟后。 / English: The suspense performance and reel 2's SLOW begins when reel 1 goes STOPPED, not after its bounce, nor after the fictitious three-second release delay.
        if (step.reel === PRIMAL_ANTICIPATION_REEL && this.anticipationPlan) {
          await impactBarriers[PRIMAL_ANTICIPATION_REEL - 1];
          if (generation !== this.presentationGeneration) return;
        }

        const mode: ReelStopMode = fastPlay || this.fastForwardRequested
          ? "FAST"
          : step.reel === this.anticipationPlan?.reel ? "SLOW" : "NORMAL";
        const fastForward = mode === "FAST";
        // 显式生产模式是固定的。注入的 NORMAL 稳定选项仍然可用于确定性单元测试。 / English: Explicit production mode is fixed. The injected NORMAL stable option is still available for deterministic unit testing.
        const settleMs = mode === "NORMAL"
          ? step.settleMs
          : reelStopMotionConfig(mode).totalMs;
        const impactMs = mode === "NORMAL"
          ? step.settleMs * REEL_IMPACT_PROGRESS
          : reelStopMotionConfig(mode).brakeMs;
        const cells = grid[step.reel] ?? [];
        this.hooks.onReelStopStart?.({
          reel: step.reel,
          cells,
          settleMs,
          impactMs,
          mode,
          fastForward,
        });
        const impact = (async (): Promise<void> => {
          if (mode === "SLOW") await this.waitForSlowImpact(impactMs);
          else await this.wait(impactMs, false);
          if (generation !== this.presentationGeneration) return;
          this.reels.commitReelImpact?.(step.reel, mode);
          try {
            this.hooks.onReelImpact?.({
              reel: step.reel,
              cells,
              settleMs,
              impactMs,
              mode,
              fastForward,
            });
          } catch {
            // 声音/触觉是装饰性的，不得干扰结算。 / English: Sounds/haptics are decorative and must not interfere with settlement.
          }
          if (step.reel === PRIMAL_ANTICIPATION_REEL - 1
            && generation === this.presentationGeneration
            && mode === "NORMAL"
            && !this.fastForwardRequested) {
            this.startAnticipation();
          }
          if (step.reel === this.anticipationPlan?.reel) {
            this.stopAnticipation("reel-impact", this.fastForwardRequested);
          }

          impactedReels.add(step.reel);
          try {
            if (!allStoppedFired && impactedReels.size === plan.length) {
              allStoppedFired = true;
              // ALLSTOPPED 是转轴输入窗口的正式终点。随后制作好的 Wild/Rage 停轴收尾不可跳过，即使本次旋转已经快进。 / English: ALLSTOPPED is the official end of the reel input window. The subsequent Wild/Rage spin ending cannot be skipped, even if the spin has been fast-forwarded.
              this.clearQuickStopReleaseTimer();
              this.spinStartedAtMs = null;
              this.hooks.onAllReelsStopped?.({
                grid,
                fastForward: this.fastForwardRequested,
              });
              // 官方停止结尾从第三个 STOPPED 开始，并与剩余的 NORMAL/FAST 反弹并行运行。 / English: The official stop ending begins with the third STOPPED and runs in parallel with the remaining NORMAL/FAST bounces.
              postStopActivation = this.presentPostStopActivation(grid, generation);
            }
          } finally {
            impactResolvers[step.reel]?.();
          }
        })();
        await Promise.all([this.reels.stopReel(
          step.reel,
          cells,
          settleMs,
          mode,
        ), impact]);
      }));
      await postStopActivation;
      if (generation !== this.presentationGeneration) {
        throw new StopPresentationCancelledError();
      }
    } catch (error) {
      if (generation === this.presentationGeneration) {
        this.stopAnticipation("error", this.fastForwardRequested);
        this.presentationGeneration += 1;
        this.releasePendingDelays();
        this.reels.cancelPresentation?.();
      }
      throw error;
    } finally {
      this.stopAnticipation("completed", this.fastForwardRequested);
      this.clearQuickStopReleaseTimer();
      this.releasePendingDelays();
      this.fastForwardRequested = false;
      this.presenting = false;
      this.spinStartedAtMs = null;
      this.anticipationPlan = null;
    }
  }

  private async presentPostStopActivation(
    grid: readonly (readonly GridCell[])[],
    generation: number,
  ): Promise<void> {
    const plan = createPostStopActivationPlan(grid);
    if (generation !== this.presentationGeneration) return;

    // 一个/两个 Rage 未命中时没有符号负责停轴收尾，但其 SLOW 转轴仍拥有同一套原生悬念 `hide`。 / English: There are no symbols responsible for the reel ending when one/two Rage misses, but the SLOW reels still have the same native set of `hide`.
    // 将结果和 Rage-collection 表现流程保留在该剪辑后面，以便路径永远不会在幸存的火框下方开始。 / English: Keep the result and Rage-collection presentation process behind this clip so that the path never starts below the surviving fire box.
    if (!plan) {
      const anticipation = this.anticipationPlan;
      if (anticipation && !this.fastForwardRequested) {
        await this.wait(
          PRIMAL_REEL_ANTICIPATION_TRANSITION_MS
            - PRIMAL_ANTICIPATION_COPY_CLEAR_LEAD_MS,
          false,
        );
        if (generation !== this.presentationGeneration) return;
        try {
          this.hooks.onAnticipationHideComplete?.({ ...anticipation, fastForward: false });
        } catch {
          // 信息线清理只是表面性的，不能阻止结算。 / English: Information line cleaning is only cosmetic and cannot prevent settlement.
        }
        await this.wait(PRIMAL_ANTICIPATION_COPY_CLEAR_LEAD_MS, false);
      }
      return;
    }

    const event: ReelPostStopActivationEvent = Object.freeze({
      ...plan,
      fastForward: this.fastForwardRequested,
    });
    try {
      this.hooks.onPostStopTransitionStart?.(event);
    } catch {
      // 过渡副本只是装饰性的，无法阻止权威解决。 / English: Transitional copy is merely cosmetic and cannot prevent authoritative resolution.
    }
    if (generation !== this.presentationGeneration) return;

    // SLOW 转轴会在独立悬念轨道完成 `hide` 前进入 STOPPED。官方停轴收尾会等待 333.333ms 片段， / English: The SLOW reels will enter STOPPED before the independent suspense track completes `hide`. The official axis-stop ending will wait for the 333.333ms clip.
    // 因此 SCATTER_FEATURE_ACTIVATE 永远不会在幸存的火框下渲染。 / English: Therefore SCATTER_FEATURE_ACTIVATE will never render under a surviving fire frame.
    if (this.anticipationPlan) {
      await this.wait(PRIMAL_REEL_ANTICIPATION_TRANSITION_MS, false);
      if (generation !== this.presentationGeneration) return;
    }
    try {
      const pending = this.hooks.onPostStopActivation?.(event);
      if (pending) await pending;
    } catch {
      // Character/背景反应是装饰性的，不能阻止结果。 / English: Character/background reactions are cosmetic and cannot prevent results.
    }
    if (generation !== this.presentationGeneration) return;
    try {
      this.reels.playPostStopActivation?.(plan);
    } catch {
      // 缺失的符号动画不得中断权威结算。 / English: Missing symbol animations must not interrupt authoritative settlement.
    }
    if (generation !== this.presentationGeneration) return;
    await this.wait(plan.delayMs, false);
    if (generation !== this.presentationGeneration) return;
    try {
      const pending = this.hooks.onPostStopActivationComplete?.(event);
      if (pending) await pending;
    } catch {
      // 只读完成观察者无法中断权威结果。 / English: Read-only completion observers cannot interrupt authoritative results.
    }
  }

  private startAnticipation(): void {
    const plan = this.anticipationPlan;
    if (!plan || this.anticipationActive || this.fastForwardRequested) return;
    this.anticipationActive = true;
    try {
      this.hooks.onAnticipationStart?.({ ...plan, fastForward: false });
    } catch {
      // 预期只是装饰性的，不得干扰结算。 / English: Expectations are cosmetic only and must not interfere with settlement.
    }
  }

  private stopAnticipation(
    reason: ReelAnticipationStopReason,
    fastForward: boolean,
  ): void {
    const plan = this.anticipationPlan;
    if (!plan || !this.anticipationActive) return;
    this.anticipationActive = false;
    try {
      this.hooks.onAnticipationStop?.({ ...plan, reason, fastForward });
    } catch {
      // 预期只是装饰性的，不得干扰结算。 / English: Expectations are cosmetic only and must not interfere with settlement.
    }
  }

  private wait(ms: number, fastForwardSkippable = true): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const pending = this.releaseDelays;
      const release = { finish, fastForwardSkippable };
      function finish(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(release);
        resolve();
      }
      const timer = setTimeout(() => {
        // 排队的快速停止会接管所有尚未启动的转轴。即使普通计时器先到期，任何转轴都不能在官方 spinStart+600ms 下限前制动；下限计时器会将它们一并释放。 / English: A queued quick stop takes over any reels that have not yet started. Even if the normal timer expires first, no reels can brake before the official spinStart+600ms lower limit; the lower limit timer will release them all together.
        if (fastForwardSkippable
          && this.fastForwardRequested
          && !this.quickStopFloorReached()) return;
        finish();
      }, ms);
      this.releaseDelays.add(release);
      if (this.fastForwardRequested && fastForwardSkippable && this.quickStopFloorReached()) finish();
    });
  }

  private waitForSlowImpact(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const pending = this.releaseDelays;
      let release: { readonly finish: () => void; readonly fastForwardSkippable: boolean };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(release);
        if (this.activeSlowImpactRelease === finish) this.activeSlowImpactRelease = null;
        resolve();
      };
      release = { finish, fastForwardSkippable: false };
      const timer = setTimeout(finish, ms);
      this.activeSlowImpactRelease = finish;
      this.releaseDelays.add(release);
    });
  }

  private quickStopFloorReached(): boolean {
    return this.spinStartedAtMs === null
      || this.clock() - this.spinStartedAtMs >= PRIMAL_REEL_TIMING_MS.fastFirstBrake;
  }

  private scheduleQuickStopRelease(): void {
    this.clearQuickStopReleaseTimer();
    const startedAt = this.spinStartedAtMs;
    const remainingMs = startedAt === null
      ? 0
      : Math.max(0, PRIMAL_REEL_TIMING_MS.fastFirstBrake - (this.clock() - startedAt));
    if (remainingMs <= 0) {
      this.releasePendingDelays(true);
      return;
    }
    this.quickStopReleaseTimer = setTimeout(() => {
      this.quickStopReleaseTimer = null;
      this.releasePendingDelays(true);
    }, remainingMs);
  }

  private clearQuickStopReleaseTimer(): void {
    if (this.quickStopReleaseTimer === null) return;
    clearTimeout(this.quickStopReleaseTimer);
    this.quickStopReleaseTimer = null;
  }

  private releasePendingDelays(fastForwardOnly = false): void {
    for (const release of [...this.releaseDelays]) {
      if (!fastForwardOnly || release.fastForwardSkippable) release.finish();
    }
  }
}
