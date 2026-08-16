import type {
  FeatureState,
  MoneyMinor,
  SessionOpened,
  SpinResult,
} from "../app/state/types";
import type {
  GameGateway,
  GatewayCallbacks,
} from "../protocol/GameGateway";
import {
  VisualFixtureGateway,
  type VisualFixtureScenarioName,
} from "./VisualFixtureGateway";

export const RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO =
  "base-rgs-recovered-level-up" satisfies VisualFixtureScenarioName;

const RECOVERED_ROUND_ID = "fixture-rgs-recovered-level-up";
const RECOVERED_BET_MINOR = "100";
const RECOVERED_SETTLED_BALANCE_MINOR = "99900";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

const RECOVERED_ORIGIN_FEATURE_STATE: Readonly<FeatureState> = immutableClone({
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 1,
  rageCollected: 11,
});

const RECOVERED_FINAL_FEATURE_STATE: Readonly<FeatureState> = immutableClone({
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 2,
  rageCollected: 12,
});

const NULL_CALLBACKS: GatewayCallbacks = {
  onStatus: () => undefined,
  onSession: () => undefined,
  onSpinResult: () => undefined,
  onError: () => undefined,
};

export interface RecoveredVisualFixtureDiagnostics {
  readonly pendingAtSession: boolean;
  readonly pendingAtResult: boolean;
  readonly deliveredBeforeLaunch: boolean;
  readonly deliveryCount: number;
  readonly acknowledgementCount: number;
  readonly deliveredOrigin: Readonly<FeatureState> | null;
  readonly deliveredResult: Readonly<SpinResult> | null;
}

/**
 * 仅测试持久恢复对等点。包裹的测试场景计算回合；该装饰器重现了 RGS 排序，其中交换状态已经前进，但提交的结果仍然处于待定状态，直到呈现 ACK。
 */
export class RecoveredVisualFixtureGateway implements GameGateway {
  private readonly delegate = new VisualFixtureGateway(
    RECOVERED_LEVEL_UP_VISUAL_FIXTURE_SCENARIO,
  );
  private callbacks: GatewayCallbacks = NULL_CALLBACKS;
  private connectStarted = false;
  private closed = false;
  private pending = true;
  private pendingAtSession = false;
  private pendingAtResult = false;
  private deliveredBeforeLaunch = false;
  private deliveryCount = 0;
  private acknowledgementCount = 0;
  private deliveredOrigin: Readonly<FeatureState> | null = null;
  private deliveredResult: Readonly<SpinResult> | null = null;

  constructor(private readonly isLaunchReady: () => boolean = () => false) {
    this.delegate.setCallbacks({
      onStatus: (status) => this.callbacks.onStatus(status),
      onSession: (session) => this.deliverAdvancedSession(session),
      onSpinResult: (result) => this.deliverRecoveredResult(result),
      onError: (error) => this.callbacks.onError(error),
    });
  }

  setCallbacks(callbacks: GatewayCallbacks): void {
    this.callbacks = callbacks;
  }

  get hasPendingSpin(): boolean {
    return this.pending;
  }

  get diagnostics(): Readonly<RecoveredVisualFixtureDiagnostics> {
    return Object.freeze({
      pendingAtSession: this.pendingAtSession,
      pendingAtResult: this.pendingAtResult,
      deliveredBeforeLaunch: this.deliveredBeforeLaunch,
      deliveryCount: this.deliveryCount,
      acknowledgementCount: this.acknowledgementCount,
      deliveredOrigin: this.deliveredOrigin,
      deliveredResult: this.deliveredResult,
    });
  }

  connect(): void {
    if (this.connectStarted || this.closed) return;
    this.connectStarted = true;
    this.delegate.connect();
  }

  requestSpin(_roundId: string, _betMinor: MoneyMinor): boolean {
    return false;
  }

  acknowledgeSpinResult(roundId: string, sequence: number): boolean {
    const delivered = this.deliveredResult;
    if (!this.pending || delivered === null
      || delivered.roundId !== roundId || delivered.sequence !== sequence) return false;
    this.pending = false;
    this.acknowledgementCount += 1;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.delegate.close();
  }

  private deliverAdvancedSession(session: SessionOpened): void {
    if (this.closed) return;
    this.pendingAtSession = this.pending;
    const advancedSession: SessionOpened = immutableClone({
      ...session,
      balanceMinor: RECOVERED_SETTLED_BALANCE_MINOR,
      featureState: RECOVERED_FINAL_FEATURE_STATE,
    });
    this.callbacks.onSession(advancedSession);

    if (!this.delegate.requestSpin(RECOVERED_ROUND_ID, RECOVERED_BET_MINOR)) {
      this.callbacks.onError(new Error("Recovered visual fixture could not produce its committed round"));
    }
  }

  private deliverRecoveredResult(result: SpinResult): void {
    if (this.closed || this.deliveredResult !== null) return;
    this.pendingAtResult = this.pending;
    this.deliveredBeforeLaunch = !this.isLaunchReady();
    this.deliveryCount += 1;
    this.deliveredOrigin = RECOVERED_ORIGIN_FEATURE_STATE;
    this.deliveredResult = result;
    this.callbacks.onSpinResult(result, RECOVERED_ORIGIN_FEATURE_STATE);
  }
}

export function createRecoveredVisualFixtureGateway(
  isLaunchReady: () => boolean = () => false,
): RecoveredVisualFixtureGateway {
  return new RecoveredVisualFixtureGateway(isLaunchReady);
}
