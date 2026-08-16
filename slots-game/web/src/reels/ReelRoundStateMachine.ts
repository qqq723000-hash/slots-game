/**
 * 转轴表现生命周期刻意与 GameStateMachine 分离。GameStateMachine 负责连接与经济状态；
 * 本状态机只负责把一轮权威结果转化为视觉运动。
 */
export const REEL_ROUND_STATES = [
  "Idle",
  "Spin_Start",
  "Spinning",
  "Spin_Stopping",
  "Reel_Stop_One_By_One",
  "Result_Show",
  "Win_Line_Animation",
] as const;

export type ReelRoundState = (typeof REEL_ROUND_STATES)[number];

export type ReelRoundEvent =
  | { readonly type: "SPIN_ACCEPTED"; readonly roundId: string }
  | { readonly type: "REELS_STARTED" }
  | { readonly type: "RESULT_RECEIVED"; readonly roundId: string; readonly rows: number }
  | { readonly type: "REEL_STOP_STARTED"; readonly reel: number }
  | { readonly type: "ALL_REELS_STOPPED" }
  | { readonly type: "WIN_PRESENTATION_STARTED" }
  | { readonly type: "ROUND_COMPLETE" }
  | { readonly type: "RESET"; readonly reason?: string };

export interface ReelRoundSnapshot {
  readonly state: ReelRoundState;
  readonly roundId: string | null;
  readonly rows: number | null;
  /** 权威制动动画已开始的卷轴，按发布顺序排列。 */
  readonly stopStartedReels: readonly number[];
  readonly revision: number;
  readonly lastEvent: ReelRoundEvent["type"] | null;
}

export type ReelRoundStateListener = (
  current: ReelRoundSnapshot,
  previous: ReelRoundSnapshot,
) => void;

export class InvalidReelRoundTransitionError extends Error {
  constructor(snapshot: ReelRoundSnapshot, event: ReelRoundEvent, detail?: string) {
    super(
      `Cannot apply ${event.type} while reel round is ${snapshot.state}`
      + (detail ? `: ${detail}` : ""),
    );
    this.name = "InvalidReelRoundTransitionError";
  }
}

const REEL_COUNT = 3;

function frozenSnapshot(
  state: ReelRoundState,
  roundId: string | null,
  rows: number | null,
  stopStartedReels: readonly number[],
  revision: number,
  lastEvent: ReelRoundEvent["type"] | null,
): ReelRoundSnapshot {
  return Object.freeze({
    state,
    roundId,
    rows,
    stopStartedReels: Object.freeze([...stopStartedReels]),
    revision,
    lastEvent,
  });
}

/** 严格的 3 卷轴视觉状态机。它从不计算游戏结果。 */
export class ReelRoundStateMachine {
  private current = frozenSnapshot("Idle", null, null, [], 0, null);
  private readonly listeners = new Set<ReelRoundStateListener>();

  get snapshot(): ReelRoundSnapshot {
    return this.current;
  }

  get state(): ReelRoundState {
    return this.current.state;
  }

  subscribe(listener: ReelRoundStateListener, emitCurrent = true): () => void {
    this.listeners.add(listener);
    if (emitCurrent) this.notifyOne(listener, this.current, this.current);
    return () => this.listeners.delete(listener);
  }

  transition(event: ReelRoundEvent): ReelRoundSnapshot {
    const previous = this.current;
    const next = event.type === "RESET"
      ? frozenSnapshot("Idle", null, null, [], previous.revision + 1, event.type)
      : this.resolve(previous, event);
    this.current = next;
    this.notify(next, previous);
    return next;
  }

  reset(reason?: string): ReelRoundSnapshot {
    return this.transition({ type: "RESET", reason });
  }

  private resolve(
    snapshot: ReelRoundSnapshot,
    event: Exclude<ReelRoundEvent, { readonly type: "RESET" }>,
  ): ReelRoundSnapshot {
    const revision = snapshot.revision + 1;
    switch (snapshot.state) {
      case "Idle": {
        if (event.type !== "SPIN_ACCEPTED") return this.invalid(snapshot, event);
        const roundId = event.roundId.trim();
        if (!roundId) return this.invalid(snapshot, event, "roundId is required");
        return frozenSnapshot("Spin_Start", roundId, null, [], revision, event.type);
      }
      case "Spin_Start":
        if (event.type !== "REELS_STARTED") return this.invalid(snapshot, event);
        return frozenSnapshot(
          "Spinning",
          snapshot.roundId,
          null,
          [],
          revision,
          event.type,
        );
      case "Spinning": {
        if (event.type !== "RESULT_RECEIVED") return this.invalid(snapshot, event);
        if (event.roundId !== snapshot.roundId) {
          return this.invalid(snapshot, event, `expected round ${snapshot.roundId}`);
        }
        if (!Number.isInteger(event.rows) || event.rows < 3 || event.rows > 8) {
          return this.invalid(snapshot, event, "rows must be an integer from 3 through 8");
        }
        return frozenSnapshot(
          "Spin_Stopping",
          snapshot.roundId,
          event.rows,
          [],
          revision,
          event.type,
        );
      }
      case "Spin_Stopping":
        if (event.type !== "REEL_STOP_STARTED") return this.invalid(snapshot, event);
        if (event.reel !== 0) {
          return this.invalid(snapshot, event, "the first stopped reel must be reel 0");
        }
        return frozenSnapshot(
          "Reel_Stop_One_By_One",
          snapshot.roundId,
          snapshot.rows,
          [event.reel],
          revision,
          event.type,
        );
      case "Reel_Stop_One_By_One": {
        if (event.type === "REEL_STOP_STARTED") {
          const expectedReel = snapshot.stopStartedReels.length;
          if (event.reel !== expectedReel || expectedReel >= REEL_COUNT) {
            return this.invalid(
              snapshot,
              event,
              `expected reel ${Math.min(expectedReel, REEL_COUNT - 1)}`,
            );
          }
          return frozenSnapshot(
            snapshot.state,
            snapshot.roundId,
            snapshot.rows,
            [...snapshot.stopStartedReels, event.reel],
            revision,
            event.type,
          );
        }
        if (event.type === "ALL_REELS_STOPPED") {
          if (snapshot.stopStartedReels.length !== REEL_COUNT) {
            return this.invalid(snapshot, event, "all three reel brakes must start first");
          }
          return frozenSnapshot(
            "Result_Show",
            snapshot.roundId,
            snapshot.rows,
            snapshot.stopStartedReels,
            revision,
            event.type,
          );
        }
        return this.invalid(snapshot, event);
      }
      case "Result_Show":
        if (event.type !== "WIN_PRESENTATION_STARTED") return this.invalid(snapshot, event);
        return frozenSnapshot(
          "Win_Line_Animation",
          snapshot.roundId,
          snapshot.rows,
          snapshot.stopStartedReels,
          revision,
          event.type,
        );
      case "Win_Line_Animation":
        if (event.type !== "ROUND_COMPLETE") return this.invalid(snapshot, event);
        return frozenSnapshot("Idle", null, null, [], revision, event.type);
      default: {
        const exhaustive: never = snapshot.state;
        return exhaustive;
      }
    }
  }

  private invalid(
    snapshot: ReelRoundSnapshot,
    event: Exclude<ReelRoundEvent, { readonly type: "RESET" }>,
    detail?: string,
  ): never {
    throw new InvalidReelRoundTransitionError(snapshot, event, detail);
  }

  private notify(current: ReelRoundSnapshot, previous: ReelRoundSnapshot): void {
    for (const listener of [...this.listeners]) this.notifyOne(listener, current, previous);
  }

  private notifyOne(
    listener: ReelRoundStateListener,
    current: ReelRoundSnapshot,
    previous: ReelRoundSnapshot,
  ): void {
    try {
      listener(current, previous);
    } catch {
      // 不允许 Debug/UI 观察者破坏权威回合。
    }
  }
}
