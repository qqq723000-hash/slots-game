export type PreloadProgressStatus = "running" | "complete";

export interface PreloadProgress {
  readonly stage: string;
  readonly taskName: string | null;
  readonly status: PreloadProgressStatus;
  readonly taskFraction: number;
  readonly completedWeight: number;
  readonly totalWeight: number;
  readonly progress: number;
}

export interface PreloadTaskContext {
  readonly signal: AbortSignal;
  /** 报告此任务在 0..1 范围内的单调完成情况。 / English: Reports monotonic completion of this task in the range 0..1. */
  report(fraction: number): void;
}

export interface PreloadTask {
  readonly name: string;
  readonly stage: string;
  readonly weight: number;
  readonly timeoutMs?: number;
  run(context: PreloadTaskContext): void | Promise<void>;
}

export type PreloadProgressHandler = (progress: Readonly<PreloadProgress>) => void;

export class PreloadTimeoutError extends Error {
  constructor(readonly taskName: string, readonly timeoutMs: number) {
    super(`Preload task "${taskName}" timed out after ${timeoutMs}ms`);
    this.name = "PreloadTimeoutError";
  }
}

export class PreloadTaskError extends Error {
  constructor(readonly taskName: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Preload task "${taskName}" failed: ${detail}`, { cause });
    this.name = "PreloadTaskError";
  }
}

export class PreloadAbortedError extends Error {
  constructor(message = "Preload was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

const MAX_RUNNING_TASK_FRACTION = 1 - 1e-6;

/**
 * 按声明顺序运行指定的入口关键启动阶段。
 *
 * 阶段仍然可以并行其自己的网络/解码工作并报告部分完成情况。门只拥有订购、加权进度、截止日期和取消；它永远不会根据任务计数来猜测进度。
 *
 * 英文 / English: Runs the specified entry-critical startup phases in the order they are declared. Stages can still parallelize their own network/decoding work and report partial completion. The gate only has ordering, weighted progress, due dates, and cancellations; it never guesses progress based on task counts.
 */
export class PreloadGate {
  private activeController: AbortController | null = null;

  constructor(
    private readonly tasks: readonly Readonly<PreloadTask>[],
    private readonly timeoutMs = 15_000,
  ) {
    assertPositiveDuration(timeoutMs, "Preload timeout");
    const names = new Set<string>();
    for (const task of tasks) {
      if (!task.name.trim()) throw new Error("Preload task name must not be empty");
      if (!task.stage.trim()) throw new Error(`Preload task "${task.name}" stage must not be empty`);
      if (names.has(task.name)) throw new Error(`Duplicate preload task name "${task.name}"`);
      names.add(task.name);
      if (!Number.isFinite(task.weight) || task.weight <= 0) {
        throw new Error(`Preload task "${task.name}" weight must be positive`);
      }
      if (task.timeoutMs !== undefined) {
        assertPositiveDuration(task.timeoutMs, `Preload task "${task.name}" timeout`);
      }
    }
  }

  abort(reason: Error = new PreloadAbortedError()): void {
    this.activeController?.abort(reason);
  }

  async run(onProgress: PreloadProgressHandler = () => undefined): Promise<void> {
    if (this.activeController) throw new Error("Preload is already running");

    const controller = new AbortController();
    this.activeController = controller;
    const totalWeight = this.tasks.reduce((total, task) => total + task.weight, 0);
    let completedWeight = 0;
    let acceptingProgress = true;

    const emit = (
      task: Readonly<PreloadTask> | null,
      taskFraction: number,
      status: PreloadProgressStatus,
      absoluteCompletedWeight = completedWeight,
    ): void => {
      if (!acceptingProgress) return;
      const progress = totalWeight === 0
        ? 1
        : clamp01(absoluteCompletedWeight / totalWeight);
      onProgress(Object.freeze({
        stage: task?.stage ?? "complete",
        taskName: task?.name ?? null,
        status,
        taskFraction: status === "complete" ? 1 : clamp01(taskFraction),
        completedWeight: totalWeight === 0 ? 0 : absoluteCompletedWeight,
        totalWeight,
        progress,
      }));
    };

    if (this.tasks.length === 0) {
      try {
        emit(null, 1, "complete", 0);
      } finally {
        acceptingProgress = false;
        this.activeController = null;
      }
      return;
    }

    try {
      for (const task of this.tasks) {
        throwIfAborted(controller.signal);
        let taskFraction = 0;
        let taskAcceptingProgress = true;
        emit(task, taskFraction, "running");

        const context: PreloadTaskContext = Object.freeze({
          signal: controller.signal,
          report: (fraction: number): void => {
            if (!acceptingProgress || !taskAcceptingProgress || controller.signal.aborted) return;
            if (!Number.isFinite(fraction)) {
              throw new Error(`Preload task "${task.name}" reported non-finite progress`);
            }
            const monotonicFraction = Math.max(taskFraction, clamp01(fraction));
            // 任务只有在其承诺得到解决后才算完成。这可以防止过早的 report(1) 在最终任务中 100% 暴露 false。 / English: A task is not complete until its commitments are resolved. This prevents premature report(1) from 100% exposing false in the final task.
            taskFraction = Math.min(monotonicFraction, MAX_RUNNING_TASK_FRACTION);
            emit(
              task,
              taskFraction,
              "running",
              completedWeight + task.weight * taskFraction,
            );
          },
        });

        try {
          try {
            await runTaskWithDeadline(
              task,
              context,
              task.timeoutMs ?? this.timeoutMs,
            );
          } catch (error) {
            if (error instanceof PreloadTimeoutError || error instanceof PreloadAbortedError) {
              throw error;
            }
            if (controller.signal.aborted) throw abortReason(controller.signal);
            throw new PreloadTaskError(task.name, error);
          }
        } finally {
          taskAcceptingProgress = false;
        }

        throwIfAborted(controller.signal);
        taskFraction = 1;
        completedWeight += task.weight;
        emit(task, taskFraction, "running", completedWeight);
      }
      emit(null, 1, "complete", totalWeight);
    } catch (error) {
      acceptingProgress = false;
      if (!controller.signal.aborted) {
        controller.abort(error instanceof Error ? error : new PreloadAbortedError());
      }
      throw error;
    } finally {
      acceptingProgress = false;
      if (this.activeController === controller) this.activeController = null;
    }
  }
}

async function runTaskWithDeadline(
  task: Readonly<PreloadTask>,
  context: PreloadTaskContext,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let removeAbortListener = (): void => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new PreloadTimeoutError(task.name, timeoutMs)),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortReason(context.signal));
    if (context.signal.aborted) {
      onAbort();
      return;
    }
    context.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => context.signal.removeEventListener("abort", onAbort);
  });
  const attempt = Promise.resolve().then(() => task.run(context));
  try {
    await Promise.race([attempt, deadline, aborted]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new PreloadAbortedError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive`);
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
