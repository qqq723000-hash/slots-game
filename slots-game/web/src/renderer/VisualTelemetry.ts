/**
 * 非权威视觉保真度遥测。事件有意仅包含表示身份：绝不下注、奖励、余额、凭证或解码结果有效负载。
 *
 * 英文 / English: Non-authoritative visual fidelity telemetry. Events intentionally only contain identity representation: never bet, reward, balance, voucher or decoded result payloads.
 */
export const VISUAL_TELEMETRY_SCHEMA_VERSION = 1 as const;

export const VISUAL_TELEMETRY_IDS = Object.freeze([
  "launch.intro",
  "background.intro",
  "background.palette",
  "character.animation",
  "reel.frame",
  "reel.symbol.land",
  "reel.symbol.win",
  "reel.anticipation",
  "rage.collect",
  "rage.cascade",
  "vault.tease",
  "vault.unlock",
  "vault.upgrade",
  "vault.award",
  "free-spin.intro.kong",
  "free-spin.intro.king",
  "free-spin.hud",
  "free-spin.retrigger",
  "free-spin.trails",
  "free-spin.summary",
  "wheel.popup",
  "wheel.ready",
  "wheel.spin",
  "wheel.landing",
  "wheel.summary",
  "wheel.outro",
  "win.normal-record",
  "win.big",
  "win.wheel-label",
] as const);

export type VisualTelemetryId = typeof VISUAL_TELEMETRY_IDS[number];
export type VisualTelemetryKind = "load" | "start" | "complete" | "fail";
export type VisualTelemetryRequirement = "required" | "conditional" | "optional";
export type VisualTelemetryMode = "authored" | "bitmap" | "procedural" | "text";
export type VisualTelemetryCompletionOutcome =
  | "natural"
  | "continued"
  | "timeout"
  | "cancelled"
  | "reduced-motion-skip";
export type VisualTelemetryFailureStage =
  | "load"
  | "create"
  | "animation"
  | "slot"
  | "runtime";
export type VisualTelemetryFailureCode =
  | "asset-load-failed"
  | "spine-create-failed"
  | "missing-animation"
  | "missing-bone"
  | "missing-slot"
  | "empty-presentation"
  | "playback-failed";
export type VisualTelemetryFallback = VisualTelemetryMode | "none";

export interface VisualTelemetryDescriptor {
  readonly id: VisualTelemetryId;
  readonly requirement: VisualTelemetryRequirement;
  readonly mode: VisualTelemetryMode;
  /** 仅限稳定公共资产标识符/URLs；没有解码的服务器事实。 / English: Stable public asset identifiers/URLs only; no decoded server facts. */
  readonly assets?: readonly string[];
  readonly clips?: readonly string[];
  readonly sourceEvent?: string;
}

export interface VisualTelemetryRuntimeContext {
  readonly sequence?: number;
  readonly sourceEvent?: string;
}

interface VisualTelemetryEventBase extends VisualTelemetryDescriptor {
  readonly schemaVersion: typeof VISUAL_TELEMETRY_SCHEMA_VERSION;
  readonly kind: VisualTelemetryKind;
  readonly operationId: number;
  readonly sequence?: number;
}

export interface VisualTelemetryLoadEvent extends VisualTelemetryEventBase {
  readonly kind: "load";
  /** 仅在解析、构造和后置条件之后才会发出加载事件。 / English: Load events are emitted only after parsing, construction and postconditions. */
  readonly constructible: true;
}

export interface VisualTelemetryStartEvent extends VisualTelemetryEventBase {
  readonly kind: "start";
}

export interface VisualTelemetryCompleteEvent extends VisualTelemetryEventBase {
  readonly kind: "complete";
  readonly outcome: VisualTelemetryCompletionOutcome;
}

export interface VisualTelemetryFailEvent extends VisualTelemetryEventBase {
  readonly kind: "fail";
  readonly stage: VisualTelemetryFailureStage;
  readonly code: VisualTelemetryFailureCode;
  readonly fallback: VisualTelemetryFallback;
}

export type VisualTelemetryEvent =
  | VisualTelemetryLoadEvent
  | VisualTelemetryStartEvent
  | VisualTelemetryCompleteEvent
  | VisualTelemetryFailEvent;

export type VisualTelemetryListener = (
  event: Readonly<VisualTelemetryEvent>,
) => void | PromiseLike<void>;

export interface VisualTelemetryFailure {
  readonly stage: VisualTelemetryFailureStage;
  readonly code: VisualTelemetryFailureCode;
  readonly fallback: VisualTelemetryFallback;
}

export interface VisualTelemetryOperation {
  readonly operationId: number;
}

interface ActiveVisualTelemetryOperation {
  readonly descriptor: Readonly<VisualTelemetryDescriptor>;
  readonly context: Readonly<VisualTelemetryRuntimeContext>;
}

export type VisualTelemetryContextProvider = () => VisualTelemetryRuntimeContext;

const EMPTY_VISUAL_TELEMETRY_CONTEXT: Readonly<VisualTelemetryRuntimeContext> = Object.freeze({});

function snapshotDescriptor(
  descriptor: VisualTelemetryDescriptor,
): Readonly<VisualTelemetryDescriptor> | null {
  try {
    const id = descriptor.id;
    const requirement = descriptor.requirement;
    const mode = descriptor.mode;
    const sourceEvent = descriptor.sourceEvent;
    const assetsSource = descriptor.assets;
    const clipsSource = descriptor.clips;
    const assets = assetsSource ? Object.freeze([...assetsSource]) : undefined;
    const clips = clipsSource ? Object.freeze([...clipsSource]) : undefined;
    return Object.freeze({ id, requirement, mode, sourceEvent, assets, clips });
  } catch {
    return null;
  }
}

function snapshotFailure(
  failure: VisualTelemetryFailure,
): Readonly<VisualTelemetryFailure> | null {
  try {
    return Object.freeze({
      stage: failure.stage,
      code: failure.code,
      fallback: failure.fallback,
    });
  } catch {
    return null;
  }
}

/**
 * 渲染视图使用的小型故障打开报告器。侦听器在当前调用堆栈中运行，永远不会等待，并且无法更改呈现时间。
 *
 * 英文 / English: Small fail-open reporter used by rendering views. Its listener runs on the current call stack, is never awaited, and cannot alter presentation timing.
 */
export class VisualTelemetryReporter {
  private listener: VisualTelemetryListener | null = null;
  private contextProvider: VisualTelemetryContextProvider | null = null;
  private nextOperationId = 1;
  private readonly active = new Map<number, ActiveVisualTelemetryOperation>();

  setListener(listener: VisualTelemetryListener | null): void {
    this.listener = listener;
  }

  setContextProvider(provider: VisualTelemetryContextProvider | null): void {
    this.contextProvider = provider;
  }

  /** 记录完全解码/解析的、可构造的视图及其后置条件。 / English: Document fully decoded/parsed, constructible views and their postconditions. */
  loaded(descriptor: VisualTelemetryDescriptor): number {
    const operationId = this.allocateOperationId();
    const details = snapshotDescriptor(descriptor);
    if (!details) return operationId;
    this.emit(Object.freeze({
      ...details,
      ...this.captureContext(details.sourceEvent),
      schemaVersion: VISUAL_TELEMETRY_SCHEMA_VERSION,
      kind: "load",
      operationId,
      constructible: true,
    }));
    return operationId;
  }

  /** 在预设的操作开始之前记录失败。 / English: Logging failure before scheduled operation starts. */
  failedToStart(
    descriptor: VisualTelemetryDescriptor,
    failure: VisualTelemetryFailure,
  ): number {
    const operationId = this.allocateOperationId();
    const details = snapshotDescriptor(descriptor);
    const failureDetails = snapshotFailure(failure);
    if (!details || !failureDetails) return operationId;
    this.emit(Object.freeze({
      ...details,
      ...this.captureContext(details.sourceEvent),
      schemaVersion: VISUAL_TELEMETRY_SCHEMA_VERSION,
      kind: "fail",
      operationId,
      ...failureDetails,
    }));
    return operationId;
  }

  /** 为每次启动/重试分配一个新的单调操作 ID。 / English: Assign a new monotonic operation ID to each start/retry. */
  start(descriptor: VisualTelemetryDescriptor): VisualTelemetryOperation {
    const operationId = this.allocateOperationId();
    const details = snapshotDescriptor(descriptor);
    const operation = Object.freeze({ operationId });
    if (!details) return operation;
    const context = this.captureContext(details.sourceEvent);
    this.active.set(operationId, { descriptor: details, context });
    this.emit(Object.freeze({
      ...details,
      ...context,
      schemaVersion: VISUAL_TELEMETRY_SCHEMA_VERSION,
      kind: "start",
      operationId,
    }));
    return operation;
  }

  /** 一项操作最多发出一个终止事件。 / English: An operation may emit at most one termination event. */
  complete(
    operation: VisualTelemetryOperation,
    outcome: VisualTelemetryCompletionOutcome = "natural",
  ): boolean {
    let operationId: number;
    try {
      operationId = operation.operationId;
    } catch {
      return false;
    }
    const active = this.active.get(operationId);
    if (!active) return false;
    this.active.delete(operationId);
    this.emit(Object.freeze({
      ...active.descriptor,
      ...active.context,
      schemaVersion: VISUAL_TELEMETRY_SCHEMA_VERSION,
      kind: "complete",
      operationId,
      outcome,
    }));
    return true;
  }

  /** 一项操作最多发出一个终端故障。 / English: An operation may issue at most one terminal fault. */
  fail(
    operation: VisualTelemetryOperation,
    failure: VisualTelemetryFailure,
  ): boolean {
    let operationId: number;
    try {
      operationId = operation.operationId;
    } catch {
      return false;
    }
    const failureDetails = snapshotFailure(failure);
    if (!failureDetails) return false;
    const active = this.active.get(operationId);
    if (!active) return false;
    this.active.delete(operationId);
    this.emit(Object.freeze({
      ...active.descriptor,
      ...active.context,
      schemaVersion: VISUAL_TELEMETRY_SCHEMA_VERSION,
      kind: "fail",
      operationId,
      ...failureDetails,
    }));
    return true;
  }

  /** 拆解是取消，绝不是保真度失败。 / English: Teardown is a cancellation, never a failure of fidelity. */
  cancelAll(): void {
    for (const operationId of [...this.active.keys()]) {
      this.complete({ operationId }, "cancelled");
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  private allocateOperationId(): number {
    const operationId = this.nextOperationId;
    this.nextOperationId += 1;
    return operationId;
  }

  private captureContext(sourceEvent?: string): Readonly<VisualTelemetryRuntimeContext> {
    try {
      const current = this.contextProvider?.() ?? EMPTY_VISUAL_TELEMETRY_CONTEXT;
      const candidateSequence = current.sequence;
      const candidateSourceEvent = current.sourceEvent;
      const sequence = Number.isSafeInteger(candidateSequence) && (candidateSequence ?? 0) >= 0
        ? candidateSequence
        : undefined;
      return Object.freeze({
        sequence,
        sourceEvent: sourceEvent ?? candidateSourceEvent,
      });
    } catch {
      // 遥测上下文是诊断性的，因此也是故障开放的。 / English: The telemetry context is diagnostic and therefore fault-open.
      return EMPTY_VISUAL_TELEMETRY_CONTEXT;
    }
  }

  private emit(event: Readonly<VisualTelemetryEvent>): void {
    const listener = this.listener;
    if (!listener) return;
    try {
      const pending = listener(event);
      if (pending && typeof pending.then === "function") {
        void Promise.resolve(pending).catch(() => undefined);
      }
    } catch {
      // 诊断监听器永远不是视觉或权威流程的一部分。 / English: Diagnostic listeners are never part of the visual or authoritative process.
    }
  }
}

/** 严格测试夹具要求这些 ID 在启动栅栏就绪前已经存在。 / English: The strict test fixture requires that these IDs exist before the launch fence is ready. */
export const VISUAL_TELEMETRY_ENTRY_REQUIRED_IDS = Object.freeze([
  "launch.intro",
  "background.intro",
  "character.animation",
  "reel.frame",
  "reel.symbol.land",
  "reel.symbol.win",
] as const satisfies readonly VisualTelemetryId[]);
