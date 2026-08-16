import { describe, expect, it, vi } from "vitest";
import { buildPaintedStartupStage } from "../src/startup/paintedStartupAssembly";
import type { FrameRequest } from "../src/startup/frameSlicedInitialization";

describe("buildPaintedStartupStage", () => {
  it("does not expose a stage as painted until two frame boundaries pass", async () => {
    const frames: Array<() => void> = [];
    const events: string[] = [];
    const requestFrame: FrameRequest = () => new Promise((resolve) => frames.push(resolve));
    const run = buildPaintedStartupStage(
      "overlay-mounted",
      () => {
        events.push("build");
        return { mounted: true };
      },
      {
        requestFrame,
        onBuilt: (stage) => events.push(`built:${stage}`),
        onPainted: (stage) => events.push(`painted:${stage}`),
      },
    );

    expect(events).toEqual(["build", "built:overlay-mounted"]);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    await Promise.resolve();
    expect(events).not.toContain("painted:overlay-mounted");
    frames.shift()?.();

    await expect(run).resolves.toEqual({ mounted: true });
    expect(events.at(-1)).toBe("painted:overlay-mounted");
  });

  it("rejects after an in-flight paint abort and emits no painted mutation", async () => {
    const controller = new AbortController();
    const frames: Array<() => void> = [];
    const painted = vi.fn();
    const reason = new Error("route disposed");
    const run = buildPaintedStartupStage("renderer-mounted", () => 1, {
      signal: controller.signal,
      requestFrame: () => new Promise((resolve) => frames.push(resolve)),
      onPainted: painted,
    });

    controller.abort(reason);
    frames.shift()?.();
    await Promise.resolve();
    frames.shift()?.();

    await expect(run).rejects.toBe(reason);
    expect(painted).not.toHaveBeenCalled();
  });

  it("never invokes the builder when already cancelled", async () => {
    const controller = new AbortController();
    const build = vi.fn(() => 1);
    controller.abort(new Error("disposed before mount"));

    await expect(buildPaintedStartupStage("shell-mounted", build, {
      signal: controller.signal,
      requestFrame: async () => undefined,
    })).rejects.toThrow("disposed before mount");
    expect(build).not.toHaveBeenCalled();
  });
});
