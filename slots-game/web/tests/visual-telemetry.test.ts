import { describe, expect, it, vi } from "vitest";
import {
  VisualTelemetryReporter,
  type VisualTelemetryDescriptor,
  type VisualTelemetryEvent,
} from "../src/renderer/VisualTelemetry";
import { reportAuthoredSymbolClipReadiness } from "../src/renderer/PixiRenderer";
import { authoredSymbolRequiredClipGaps } from "../src/reels/SymbolView";

const descriptor: VisualTelemetryDescriptor = Object.freeze({
  id: "wheel.spin",
  requirement: "conditional",
  mode: "authored",
  sourceEvent: "wheel.awarded",
});

describe("VisualTelemetryReporter", () => {
  it("swallows synchronous listener throws and rejected listener promises", async () => {
    const reporter = new VisualTelemetryReporter();
    const listener = vi.fn()
      .mockImplementationOnce(() => { throw new Error("observer throw"); })
      .mockImplementationOnce(() => Promise.reject(new Error("observer reject")));
    reporter.setListener(listener);

    const operation = reporter.start(descriptor);
    expect(reporter.complete(operation)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("emits exactly one terminal event", () => {
    const events: VisualTelemetryEvent[] = [];
    const reporter = new VisualTelemetryReporter();
    reporter.setListener((event) => { events.push(event); });
    const operation = reporter.start(descriptor);

    expect(reporter.complete(operation, "natural")).toBe(true);
    expect(reporter.complete(operation, "timeout")).toBe(false);
    expect(reporter.fail(operation, {
      stage: "runtime",
      code: "playback-failed",
      fallback: "none",
    })).toBe(false);

    expect(events.map(({ kind }) => kind)).toEqual(["start", "complete"]);
  });

  it("allocates fresh monotonic operation ids for retries and captures context", () => {
    const events: VisualTelemetryEvent[] = [];
    const reporter = new VisualTelemetryReporter();
    reporter.setContextProvider(() => ({ sequence: 17, sourceEvent: "fallback-source" }));
    reporter.setListener((event) => { events.push(event); });

    const first = reporter.start(descriptor);
    reporter.fail(first, {
      stage: "animation",
      code: "playback-failed",
      fallback: "procedural",
    });
    const retry = reporter.start(descriptor);

    expect(retry.operationId).toBeGreaterThan(first.operationId);
    expect(events[0]).toMatchObject({ sequence: 17, sourceEvent: "wheel.awarded" });
  });

  it("classifies teardown and reduced motion as completion outcomes", () => {
    const events: VisualTelemetryEvent[] = [];
    const reporter = new VisualTelemetryReporter();
    reporter.setListener((event) => { events.push(event); });
    const cancelled = reporter.start(descriptor);
    const skipped = reporter.start({ ...descriptor, id: "rage.collect" });

    reporter.complete(skipped, "reduced-motion-skip");
    reporter.cancelAll();

    expect(events.filter((event) => event.kind === "complete")).toEqual([
      expect.objectContaining({ operationId: skipped.operationId, outcome: "reduced-motion-skip" }),
      expect.objectContaining({ operationId: cancelled.operationId, outcome: "cancelled" }),
    ]);
    expect(reporter.activeCount).toBe(0);
  });

  it("fails open when context getters or proxies throw", () => {
    const events: VisualTelemetryEvent[] = [];
    const reporter = new VisualTelemetryReporter();
    reporter.setListener((event) => { events.push(event); });
    reporter.setContextProvider(() => new Proxy({}, {
      get: () => { throw new Error("hostile context getter"); },
    }));

    expect(() => reporter.loaded(descriptor)).not.toThrow();
    expect(() => reporter.start(descriptor)).not.toThrow();
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.sequence === undefined)).toBe(true);
  });

  it("keeps every public reporting API fail-open for hostile inputs", () => {
    const reporter = new VisualTelemetryReporter();
    const hostileDescriptor = new Proxy({} as VisualTelemetryDescriptor, {
      get: () => { throw new Error("hostile descriptor getter"); },
    });
    const hostileFailure = new Proxy({} as Parameters<typeof reporter.fail>[1], {
      get: () => { throw new Error("hostile failure getter"); },
    });
    const hostileOperation = new Proxy({ operationId: 1 }, {
      get: () => { throw new Error("hostile operation getter"); },
    });

    expect(() => reporter.loaded(hostileDescriptor)).not.toThrow();
    expect(() => reporter.failedToStart(hostileDescriptor, hostileFailure)).not.toThrow();
    expect(() => reporter.start(hostileDescriptor)).not.toThrow();
    expect(() => reporter.complete(hostileOperation)).not.toThrow();
    expect(() => reporter.fail(hostileOperation, hostileFailure)).not.toThrow();
    expect(() => reporter.cancelAll()).not.toThrow();

    const valid = reporter.start(descriptor);
    expect(reporter.fail(valid, hostileFailure)).toBe(false);
    expect(reporter.complete(valid)).toBe(true);
  });

  it("fails land and win readiness when required clips are missing", () => {
    const checked: string[] = [];
    const gaps = authoredSymbolRequiredClipGaps((key, animation) => {
      checked.push(`${key}:${animation}`);
      return `${key}:${animation}` !== "symbol2:land"
        && `${key}:${animation}` !== "symbol5:win";
    });
    const events: VisualTelemetryEvent[] = [];
    const reporter = new VisualTelemetryReporter();
    reporter.setListener((event) => { events.push(event); });

    expect(reportAuthoredSymbolClipReadiness(reporter, gaps)).toEqual({
      land: false,
      win: false,
    });
    expect(events).toEqual([
      expect.objectContaining({
        kind: "fail",
        id: "reel.symbol.land",
        code: "missing-animation",
        clips: ["symbol2:land"],
      }),
      expect.objectContaining({
        kind: "fail",
        id: "reel.symbol.win",
        code: "missing-animation",
        clips: ["symbol5:win"],
      }),
    ]);
    expect(checked).not.toContain("symbol7:win");
    expect(checked).not.toContain("symbol8:win");
    expect(checked).not.toContain("symbol9:win");
  });
});
