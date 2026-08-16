import type { FrameRequest } from "./frameSlicedInitialization";

export const STAGED_COMPONENT_BATCH_CAP = 1;

export interface StagedComponentConstructionStage {
  readonly id: string;
  /**
   * 构造一个逻辑所有者。返回处理程序会将临时所有权转移给运行程序，直到完成的图明确采用它为止。
   */
  readonly build: () => void | (() => void);
}

export interface StagedComponentConstructionEvent {
  readonly stage: string;
  readonly frame: number;
  readonly completed: number;
  readonly total: number;
  readonly componentCount: 1;
  readonly durationMs: number;
}

export interface StagedComponentConstructionOptions {
  readonly signal?: AbortSignal;
  readonly requestFrame: FrameRequest;
  readonly now?: () => number;
  readonly onProgress?: (fraction: number) => void;
  readonly onStage?: (event: Readonly<StagedComponentConstructionEvent>) => void;
}

export interface StagedComponentConstructionOwnership {
  /** 将每个构建的所有者纳入最终图中，而不对其进行处置。 */
  release(): void;
  /** 按照相反的构建顺序一次性处理所有仍拥有的组件。 */
  dispose(): void;
}

export interface StagedGraphOwnershipTransfer {
  readonly graphOwnsComponents: boolean;
  /** 在最终图表采用该组件之前使用的清理。 */
  componentDisposer(dispose: () => void): () => void;
  /**
   * 以原子方式将每个组件传输到完整的图表中。其退回的处理器成为唯一的拆解所有者；先前的组件处理器无操作。
   */
  transferToGraph(disposeGraph: () => void): () => void;
}

/** 分阶段最终所有者图的显式一次性所有权转移。 */
export function createStagedGraphOwnershipTransfer(): StagedGraphOwnershipTransfer {
  let graphOwnsComponents = false;
  return {
    get graphOwnsComponents() {
      return graphOwnsComponents;
    },
    componentDisposer(dispose: () => void): () => void {
      const disposeOnce = once(dispose);
      return () => {
        if (graphOwnsComponents) return;
        disposeOnce();
      };
    },
    transferToGraph(disposeGraph: () => void): () => void {
      if (graphOwnsComponents) {
        throw new Error("Staged components already belong to a completed graph");
      }
      graphOwnsComponents = true;
      return once(disposeGraph);
    },
  };
}

/**
 * 在每个动画帧边界之后准确构建一个逻辑组件。
 *
 * 进度故意保持在 1 以下：调用者拥有最终的图形连接，并且只有在连接成功后才可以发布一个。任何取消或构建错误都会以相反的顺序破坏已创建的所有者。
 */
export async function runStagedComponentConstruction(
  stages: readonly StagedComponentConstructionStage[],
  options: StagedComponentConstructionOptions,
): Promise<StagedComponentConstructionOwnership> {
  validateStages(stages);
  const now = options.now ?? performanceNow;
  const disposers: Array<() => void> = [];
  let ownershipActive = true;
  let frame = 0;

  const dispose = (): void => {
    if (!ownershipActive) return;
    ownershipActive = false;
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        disposers[index]?.();
      } catch {
        // 拆解是尽最大努力，但一个坏主人不能让其他人陷入困境。
      }
    }
    disposers.length = 0;
  };
  const release = (): void => {
    if (!ownershipActive) return;
    ownershipActive = false;
    disposers.length = 0;
  };

  options.onProgress?.(0);
  try {
    throwIfAborted(options.signal);
    for (let index = 0; index < stages.length; index += 1) {
      await options.requestFrame();
      frame += 1;
      throwIfAborted(options.signal);
      const stage = stages[index]!;
      const startedAt = now();
      const disposer = stage.build();
      if (disposer) disposers.push(once(disposer));
      const durationMs = Math.max(0, now() - startedAt);
      throwIfAborted(options.signal);
      const completed = index + 1;
      options.onStage?.(Object.freeze({
        stage: stage.id,
        frame,
        completed,
        total: stages.length,
        componentCount: STAGED_COMPONENT_BATCH_CAP,
        durationMs,
      }));
      // 为成功的最终图形接线保留最后的进度量。
      options.onProgress?.(completed / (stages.length + 1));
    }
    return Object.freeze({ release, dispose });
  } catch (error) {
    dispose();
    throw error;
  }
}

function validateStages(stages: readonly StagedComponentConstructionStage[]): void {
  const ids = new Set<string>();
  for (const stage of stages) {
    if (!stage.id.trim()) throw new Error("Staged component id must not be empty");
    if (ids.has(stage.id)) throw new Error(`Duplicate staged component id: ${stage.id}`);
    ids.add(stage.id);
  }
}

function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}

function performanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Staged component construction was aborted");
  error.name = "AbortError";
  throw error;
}
