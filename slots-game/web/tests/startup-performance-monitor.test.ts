import { afterEach, describe, expect, it } from "vitest";
import {
  finishStartupPerformanceMonitor,
  startStartupPerformanceMonitor,
} from "../src/startup/startupPerformanceMonitor";

afterEach(() => finishStartupPerformanceMonitor());

describe("startup performance monitor", () => {
  it("records cross-browser frame gaps through the readiness barrier", () => {
    const root = { dataset: {} } as unknown as HTMLElement;
    const callbacks: FrameRequestCallback[] = [];
    let nextHandle = 0;
    const finish = startStartupPerformanceMonitor(root, {
      requestFrame: (callback) => {
        callbacks.push(callback);
        nextHandle += 1;
        return nextHandle;
      },
      cancelFrame: () => undefined,
      observerConstructor: null,
    });

    callbacks.shift()?.(0);
    callbacks.shift()?.(16);
    callbacks.shift()?.(86);
    finish();

    expect(root.dataset).toMatchObject({
      startupFrameMonitor: "complete",
      startupLongTaskMonitor: "unsupported",
      startupFrameCount: "3",
      startupSlowFrameCount: "1",
      startupMaxFrameGapMs: "70.000",
      startupMaxFrameGapStage: "entry",
      startupLongTaskCount: "0",
    });
  });

  it("finishes only the monitor owned by the supplied root", () => {
    const owner = { dataset: {} } as unknown as HTMLElement;
    const stranger = { dataset: {} } as unknown as HTMLElement;
    startStartupPerformanceMonitor(owner, {
      requestFrame: () => 1,
      cancelFrame: () => undefined,
      observerConstructor: null,
    });

    finishStartupPerformanceMonitor(stranger);
    expect(owner.dataset.startupFrameMonitor).toBe("running");
    finishStartupPerformanceMonitor(owner);
    expect(owner.dataset.startupFrameMonitor).toBe("complete");
  });
});
