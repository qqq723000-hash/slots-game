export interface StartupPerformanceMonitorOptions {
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly observerConstructor?: typeof PerformanceObserver | null;
}

interface ActiveStartupPerformanceMonitor {
  readonly root: HTMLElement;
  finish(): void;
}

let activeMonitor: ActiveStartupPerformanceMonitor | null = null;

/**
 * 通过已绘制的准备屏障从微小的入口模块观察真实的帧间失速。 Long Task API 数据在主机暴露时添加；框架间隙仍然是跨浏览器的基线。
 *
 * 英文 / English: Observe realistic frame-to-frame stalls from tiny entry blocks through drawn preparation barriers. Long Task API data is added when the host is exposed; frame gaps remain a cross-browser baseline.
 */
export function startStartupPerformanceMonitor(
  root: HTMLElement,
  options: StartupPerformanceMonitorOptions = {},
): () => void {
  activeMonitor?.finish();
  const hostRequestFrame = Reflect.get(globalThis, "requestAnimationFrame") as
    ((callback: FrameRequestCallback) => number) | undefined;
  const hostCancelFrame = Reflect.get(globalThis, "cancelAnimationFrame") as
    ((handle: number) => void) | undefined;
  const requestFrame = options.requestFrame ?? hostRequestFrame?.bind(globalThis);
  const cancelFrame = options.cancelFrame ?? hostCancelFrame?.bind(globalThis);
  const HostObserver = Reflect.get(globalThis, "PerformanceObserver") as
    typeof PerformanceObserver | undefined;
  const Observer = options.observerConstructor === undefined
    ? HostObserver
    : options.observerConstructor;
  let frameHandle: number | null = null;
  let lastFrameTime: number | null = null;
  let frameCount = 0;
  let slowFrameCount = 0;
  let maxFrameGapMs = 0;
  let maxFrameGapStage = "entry";
  let longTaskCount = 0;
  let maxLongTaskMs = 0;
  let maxLongTaskStage = "entry";
  const slowFrameTrace: Array<Readonly<{ stage: string; durationMs: number }>> = [];
  const longTaskTrace: Array<Readonly<{ stage: string; durationMs: number }>> = [];
  let finished = false;
  let observer: PerformanceObserver | null = null;

  root.dataset.startupFrameMonitor = requestFrame ? "running" : "unsupported";
  root.dataset.startupLongTaskMonitor = Observer ? "running" : "unsupported";

  const sampleFrame: FrameRequestCallback = (time) => {
    if (finished) return;
    if (lastFrameTime !== null) {
      const gap = Math.max(0, time - lastFrameTime);
      if (gap > maxFrameGapMs) {
        maxFrameGapMs = gap;
        maxFrameGapStage = currentStartupStage(root);
      }
      if (gap >= 50) {
        slowFrameCount += 1;
        if (slowFrameTrace.length < 32) {
          slowFrameTrace.push(Object.freeze({
            stage: currentStartupStage(root),
            durationMs: Number(gap.toFixed(3)),
          }));
        }
      }
    }
    lastFrameTime = time;
    frameCount += 1;
    try {
      frameHandle = requestFrame?.(sampleFrame) ?? null;
    } catch {
      frameHandle = null;
      root.dataset.startupFrameMonitor = "unsupported";
    }
  };

  if (requestFrame) {
    try {
      frameHandle = requestFrame(sampleFrame);
    } catch {
      root.dataset.startupFrameMonitor = "unsupported";
    }
  }

  if (Observer) {
    try {
      observer = new Observer((list) => {
        if (finished) return;
        for (const entry of list.getEntries()) {
          longTaskCount += 1;
          if (longTaskTrace.length < 32) {
            longTaskTrace.push(Object.freeze({
              stage: currentStartupStage(root),
              durationMs: Number(entry.duration.toFixed(3)),
            }));
          }
          if (entry.duration > maxLongTaskMs) {
            maxLongTaskMs = entry.duration;
            maxLongTaskStage = currentStartupStage(root);
          }
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      observer = null;
      root.dataset.startupLongTaskMonitor = "unsupported";
    }
  }

  const monitor: ActiveStartupPerformanceMonitor = {
    root,
    finish: () => {
      if (finished) return;
      finished = true;
      if (frameHandle !== null) cancelFrame?.(frameHandle);
      observer?.disconnect();
      root.dataset.startupFrameMonitor = frameHandle === null ? "unsupported" : "complete";
      if (root.dataset.startupLongTaskMonitor !== "unsupported") {
        root.dataset.startupLongTaskMonitor = "complete";
      }
      root.dataset.startupFrameCount = String(frameCount);
      root.dataset.startupSlowFrameCount = String(slowFrameCount);
      root.dataset.startupMaxFrameGapMs = maxFrameGapMs.toFixed(3);
      root.dataset.startupMaxFrameGapStage = maxFrameGapStage;
      root.dataset.startupLongTaskCount = String(longTaskCount);
      root.dataset.startupMaxLongTaskMs = maxLongTaskMs.toFixed(3);
      root.dataset.startupMaxLongTaskStage = maxLongTaskStage;
      root.dataset.startupSlowFrameTrace = JSON.stringify(slowFrameTrace);
      root.dataset.startupLongTaskTrace = JSON.stringify(longTaskTrace);
      if (activeMonitor === monitor) activeMonitor = null;
    },
  };
  activeMonitor = monitor;
  return monitor.finish;
}

export function finishStartupPerformanceMonitor(root?: HTMLElement): void {
  if (!activeMonitor) return;
  if (root && activeMonitor.root !== root) return;
  activeMonitor.finish();
}

function currentStartupStage(root: HTMLElement): string {
  return root.dataset.startupGpuStage
    || root.dataset.startupReadinessStage
    || root.dataset.startupAssemblyStage
    || root.dataset.startupShell
    || "entry";
}
