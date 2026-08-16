import { describe, expect, it } from "vitest";
import {
  PRIMAL_SCHEDULER_POLICY,
  Timeline,
  type TimelineClock,
} from "../src/startup/Timeline";
import { INTRO_DURATION_MS, introFrameAt, reducedIntroFrame } from "../src/startup/introTimeline";

class ManualClock implements TimelineClock {
  private time = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, (time: number) => void>();

  now(): number {
    return this.time;
  }

  requestFrame(callback: (time: number) => void): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.callbacks.delete(handle);
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(this.time));
  }
}

describe("Timeline", () => {
  it("uses an injected clock and emits cues in order", async () => {
    const clock = new ManualClock();
    const frames: number[] = [];
    const cues: string[] = [];
    const timeline = new Timeline({
      durationMs: 1_000,
      clock,
      cues: [{ name: "start", atMs: 0 }, { name: "middle", atMs: 500 }],
      onFrame: (time) => frames.push(time),
      onCue: (cue) => cues.push(cue.name),
    });
    const completed = timeline.play();
    clock.advance(400);
    clock.advance(200);
    clock.advance(500);
    await completed;
    expect(frames).toEqual([0, 400, 600, 1_000]);
    expect(cues).toEqual(["start", "middle"]);
  });

  it("skip applies the terminal frame exactly once and cancels future work", async () => {
    const clock = new ManualClock();
    const frames: number[] = [];
    const timeline = new Timeline({
      durationMs: 1_000,
      clock,
      onFrame: (time) => frames.push(time),
    });
    const completed = timeline.play();
    clock.advance(120);
    timeline.skip();
    timeline.skip();
    clock.advance(2_000);
    await completed;
    expect(frames).toEqual([0, 120, 1_000]);
  });

  it("caps a stalled frame with the official 30fps five-tick scheduler", async () => {
    const clock = new ManualClock();
    const frames: number[] = [];
    const timeline = new Timeline({
      durationMs: 1_000,
      clock,
      scheduler: PRIMAL_SCHEDULER_POLICY,
      onFrame: (time) => frames.push(time),
    });
    const completed = timeline.play();

    clock.advance(750);
    expect(frames[1]).toBeCloseTo(166.666_667, 5);

    clock.advance(16.666_667);
    expect(frames[2]).toBeCloseTo(183.333_334, 5);

    timeline.skip();
    await completed;
    expect(frames.at(-1)).toBe(1_000);
  });

  it("reduced motion reaches the exact normal terminal scene state", () => {
    expect(reducedIntroFrame(1)).toEqual(introFrameAt(INTRO_DURATION_MS));
  });

  it("rejects and cancels future frames when a frame callback fails", async () => {
    const clock = new ManualClock();
    const frames: number[] = [];
    const timeline = new Timeline({
      durationMs: 1_000,
      clock,
      onFrame: (time) => {
        frames.push(time);
        if (time >= 400) throw new Error("render failed");
      },
    });
    const completed = timeline.play();
    clock.advance(400);
    clock.advance(400);
    await expect(completed).rejects.toThrow("render failed");
    expect(frames).toEqual([0, 400]);
  });
});
