export const DEFAULT_CRITICAL_FONT_DESCRIPTORS = Object.freeze([
  '700 16px "Primal Kanit"',
  '700 16px "Primal Roboto Condensed"',
  '400 16px "Primal Roboto Condensed Regular"',
  'normal 16px "ROBOTO_CONDENSED_BOLD"',
  'normal 16px "ROBOTO_CONDENSED_REGULAR"',
] as const);

export const CRITICAL_DOM_PROGRESS_WEIGHTS = Object.freeze({
  images: 0.8,
  fonts: 0.2,
} as const);

export type CriticalDomReadinessStage = "images" | "fonts" | "complete";

export interface CriticalDomReadinessProgress {
  readonly stage: CriticalDomReadinessStage;
  readonly stageCompleted: number;
  readonly stageTotal: number;
  readonly stageProgress: number;
  readonly progress: number;
}

/** `document.fonts` 和确定性测试共享的最小结构表面。 */
export interface CriticalFontFaceSet {
  load?(font: string, text?: string): PromiseLike<readonly unknown[]>;
  readonly ready?: PromiseLike<unknown>;
}

/** `HTMLElement`、`Document`和`DocumentFragment`均满足该合同。 */
export type CriticalDomRoot = Pick<ParentNode, "querySelectorAll"> & {
  readonly ownerDocument?: Document | null;
};

export interface CriticalDomReadinessOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Readonly<CriticalDomReadinessProgress>) => void;
  readonly fontDescriptors?: readonly string[];
  /**
   * 测试/嵌入接口。省略使用`root.ownerDocument.fonts`；当主机故意没有 FontFaceSet 实现时，传递 `null`。
   */
  readonly fontSet?: CriticalFontFaceSet | null;
}

export class CriticalDomResourceError extends Error {
  constructor(
    readonly kind: "image" | "font",
    readonly resource: string,
    cause?: unknown,
  ) {
    super(`Required DOM ${kind} failed to become ready: ${resource}`, cause === undefined
      ? undefined
      : { cause });
    this.name = "CriticalDomResourceError";
  }
}

/**
 * 仅在 `root` 下面的每个图像已加载/解码并且每个请求的文档字体加上 `document.fonts.ready` 已解决后才解决。
 *
 * 该函数不会启动场景构建。它是一个独立的启动屏障，可以组成加权应用程序门。
 */
export async function waitForCriticalDomReadiness(
  root: CriticalDomRoot,
  options: CriticalDomReadinessOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(options.signal, controller);
  const signal = controller.signal;
  const report = monotonicReporter(options.onProgress);

  try {
    throwIfAborted(signal);
    const images = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
    report(stageProgress("images", 0, images.length, 0));

    let completedImages = 0;
    try {
      await Promise.all(images.map(async (image) => {
        await waitForRequiredImage(image, signal);
        completedImages += 1;
        report(stageProgress(
          "images",
          completedImages,
          images.length,
          weightedProgress(completedImages, images.length, 0, 0),
        ));
      }));
    } catch (error) {
      if (!signal.aborted) controller.abort(error);
      throw error;
    }
    if (images.length === 0) {
      report(stageProgress("images", 0, 0, CRITICAL_DOM_PROGRESS_WEIGHTS.images));
    }

    throwIfAborted(signal);
    const fontSet = resolveFontSet(root, options);
    const descriptors = options.fontDescriptors ?? DEFAULT_CRITICAL_FONT_DESCRIPTORS;
    const loadDescriptors = fontSet?.load ? descriptors : [];
    const hasReadyBarrier = fontSet?.ready !== undefined;
    const fontTotal = loadDescriptors.length + (hasReadyBarrier ? 1 : 0);
    let completedFonts = 0;
    report(stageProgress(
      "fonts",
      completedFonts,
      fontTotal,
      weightedProgress(images.length, images.length, completedFonts, fontTotal),
    ));

    if (fontSet?.load) {
      try {
        await Promise.all(loadDescriptors.map(async (descriptor) => {
          const loaded = await abortable(
            Promise.resolve(fontSet.load!(descriptor)),
            signal,
          );
          if (loaded.length === 0) throw new CriticalDomResourceError("font", descriptor);
          completedFonts += 1;
          report(stageProgress(
            "fonts",
            completedFonts,
            fontTotal,
            weightedProgress(images.length, images.length, completedFonts, fontTotal),
          ));
        }));
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (error instanceof CriticalDomResourceError) throw error;
        throw new CriticalDomResourceError("font", "document.fonts.load", error);
      }
    }

    if (hasReadyBarrier) {
      try {
        await abortable(Promise.resolve(fontSet!.ready), signal);
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        throw new CriticalDomResourceError("font", "document.fonts.ready", error);
      }
      completedFonts += 1;
      report(stageProgress(
        "fonts",
        completedFonts,
        fontTotal,
        weightedProgress(images.length, images.length, completedFonts, fontTotal),
      ));
    } else if (fontTotal === 0) {
      report(stageProgress("fonts", 0, 0, 1));
    }

    throwIfAborted(signal);
    report(Object.freeze({
      stage: "complete",
      stageCompleted: 1,
      stageTotal: 1,
      stageProgress: 1,
      progress: 1,
    }));
  } catch (error) {
    if (!signal.aborted) controller.abort(error);
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (signal.aborted && signal.reason !== error) throw abortReason(signal);
    throw error;
  } finally {
    unlinkAbort();
  }
}

async function waitForRequiredImage(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const source = image.currentSrc || image.src || image.getAttribute("src") || "<missing src>";
  if (source === "<missing src>") throw new CriticalDomResourceError("image", source);

  if (typeof image.decode === "function") {
    try {
      await abortable(Promise.resolve().then(() => image.decode()), signal);
      return;
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new CriticalDomResourceError("image", source, error);
    }
  }

  // jsdom 和旧版 WebKit 可能会省略 `decode`。具有自然尺寸的完整图像已经是安全的；否则，加载/错误事件是唯一可用的权威就绪信号。
  if (image.complete) {
    if (image.naturalWidth > 0) return;
    throw new CriticalDomResourceError("image", source);
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onLoad = (): void => settle();
    const onError = (event: Event): void => {
      settle(new CriticalDomResourceError("image", source, event));
    };
    const onAbort = (): void => settle(abortReason(signal));

    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });

    // 关闭初始检查和侦听器之间的缓存图像竞争。
    if (signal.aborted) onAbort();
    else if (image.complete) {
      if (image.naturalWidth > 0) onLoad();
      else onError(new Event("error"));
    }
  });
}

function resolveFontSet(
  root: CriticalDomRoot,
  options: CriticalDomReadinessOptions,
): CriticalFontFaceSet | null {
  if (Object.prototype.hasOwnProperty.call(options, "fontSet")) return options.fontSet ?? null;
  const ownerFonts = root.ownerDocument?.fonts as CriticalFontFaceSet | undefined;
  if (ownerFonts) return ownerFonts;
  if (typeof document !== "undefined") {
    return (document.fonts as CriticalFontFaceSet | undefined) ?? null;
  }
  return null;
}

function stageProgress(
  stage: Exclude<CriticalDomReadinessStage, "complete">,
  completed: number,
  total: number,
  progress: number,
): Readonly<CriticalDomReadinessProgress> {
  return Object.freeze({
    stage,
    stageCompleted: completed,
    stageTotal: total,
    stageProgress: total === 0 ? 1 : clamp01(completed / total),
    progress: clamp01(progress),
  });
}

function weightedProgress(
  completedImages: number,
  totalImages: number,
  completedFonts: number,
  totalFonts: number,
): number {
  const imageProgress = totalImages === 0 ? 1 : clamp01(completedImages / totalImages);
  // 零大小字体阶段由下面的显式兼容性事件完成。在此之前，它不得为图像进步贡献 20% 的权重。
  const fontProgress = totalFonts === 0 ? 0 : clamp01(completedFonts / totalFonts);
  return imageProgress * CRITICAL_DOM_PROGRESS_WEIGHTS.images
    + fontProgress * CRITICAL_DOM_PROGRESS_WEIGHTS.fonts;
}

function monotonicReporter(
  handler: CriticalDomReadinessOptions["onProgress"],
): (progress: Readonly<CriticalDomReadinessProgress>) => void {
  let lastProgress = 0;
  return (event) => {
    const monotonic = Math.max(lastProgress, clamp01(event.progress));
    lastProgress = monotonic;
    handler?.(monotonic === event.progress ? event : Object.freeze({
      ...event,
      progress: monotonic,
    }));
  };
}

function abortable<T>(attempt: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    attempt.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => undefined;
  const forward = (): void => target.abort(abortReason(source));
  if (source.aborted) {
    forward();
    return () => undefined;
  }
  source.addEventListener("abort", forward, { once: true });
  return () => source.removeEventListener("abort", forward);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Critical DOM readiness was aborted");
  error.name = "AbortError";
  return error;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
