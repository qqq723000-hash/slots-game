export type FrameRequest = () => Promise<void>;

export interface FrameSlicedInitializationOptions {
  readonly batchSize: number;
  readonly signal?: AbortSignal;
  readonly requestFrame?: FrameRequest;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (fraction: number) => void;
}

/**
 * 仅在动画帧边界之后运行有界同步构造工作。调用者拥有实际对象；该助手保证没有任何调用超过 `batchSize` 并且取消会阻止突变。
 */
export async function runFrameSlicedInitialization(
  total: number,
  initializeBatch: (start: number, count: number) => void,
  options: FrameSlicedInitializationOptions,
): Promise<void> {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("Frame-sliced initialization total must be a non-negative integer");
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new Error("Frame-sliced initialization batch size must be a positive integer");
  }

  const requestFrame = options.requestFrame ?? defaultFrameRequest;
  const cancelled = (): boolean => (
    options.signal?.aborted === true || options.isCancelled?.() === true
  );
  throwIfCancelled(options.signal, cancelled());

  if (total === 0) {
    options.onProgress?.(1);
    return;
  }

  let initialized = 0;
  while (initialized < total) {
    await requestFrame();
    throwIfCancelled(options.signal, cancelled());
    const count = Math.min(options.batchSize, total - initialized);
    initializeBatch(initialized, count);
    initialized += count;
    throwIfCancelled(options.signal, cancelled());
    options.onProgress?.(initialized / total);
  }
}

/** 两个 rAF 边界保证调用者插入的 DOM 绘制一次。 */
export function waitForPaintedFrame(
  requestFrame: FrameRequest = defaultFrameRequest,
): Promise<void> {
  return requestFrame().then(() => requestFrame());
}

function defaultFrameRequest(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    };
    // 浏览器在后台选项卡中暂停 rAF。当 rAF 可用时，有界计时器保留取消/超时语义，而不与可见帧竞争。
    const fallback = setTimeout(finish, 50);
    if (typeof requestAnimationFrame === "function") {
      try {
        requestAnimationFrame(finish);
        return;
      } catch {
        // Polyfill 可以在窗口/计时器主机准备就绪之前公开 rAF。有界定时器仍然是权威的兼容性路径。
      }
    }
  });
}

function throwIfCancelled(signal: AbortSignal | undefined, cancelled: boolean): void {
  if (!cancelled) return;
  if (signal?.reason instanceof Error) throw signal.reason;
  const error = new Error("Frame-sliced initialization was aborted");
  error.name = "AbortError";
  throw error;
}
