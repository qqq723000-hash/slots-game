import { describe, expect, it, vi } from "vitest";
import type { LaunchScene } from "../src/renderer/intro/LaunchScene";
import {
  IntroDirector,
  SwitchableLaunchClock,
  type IntroCompletion,
} from "../src/startup/IntroDirector";
import type { TimelineClock } from "../src/startup/Timeline";

class ManualClock implements TimelineClock {
  private time = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, (time: number) => void>();

  now(): number { return this.time; }

  requestFrame(callback: (time: number) => void): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void { this.callbacks.delete(handle); }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(this.time));
  }
}

class MutablePlaybackClock {
  time = 0;
  now(): number { return this.time; }
}

function advanceRendered(clock: ManualClock, milliseconds: number): void {
  let remaining = milliseconds;
  while (remaining > 0.000_001) {
    const step = Math.min(100, remaining);
    clock.advance(step);
    remaining -= step;
  }
}

function sceneStub(): LaunchScene {
  return { applyFrame: vi.fn() } as unknown as LaunchScene;
}

describe("IntroDirector completion branches", () => {
  it("holds launch visuals on a frozen audio epoch and advances with audio after resume", async () => {
    const wall = new ManualClock();
    const audio = new MutablePlaybackClock();
    const launchClock = new SwitchableLaunchClock(wall);
    const frameTimes: number[] = [];
    const director = new IntroDirector(sceneStub(), {
      clock: launchClock,
      clockOwnsElapsedTime: true,
      onFrame: (_frame, timeMs) => frameTimes.push(timeMs),
    });

    launchClock.follow(audio);
    const finished = director.play();
    wall.advance(750);
    wall.advance(750);
    expect(frameTimes).toEqual([0, 0, 0]);

    audio.time = 166.666_667;
    wall.advance(1);
    expect(frameTimes.at(-1)).toBeCloseTo(166.666_667, 5);
    while (audio.time < 5_000) {
      audio.time = Math.min(5_000, audio.time + 100);
      wall.advance(1);
    }
    await finished;
    expect(frameTimes.at(-1)).toBe(5_000);
  });

  it("falls back from a rejected audio unlock without a launch-time jump", async () => {
    const wall = new ManualClock();
    const audio = new MutablePlaybackClock();
    const launchClock = new SwitchableLaunchClock(wall);
    const frameTimes: number[] = [];
    const director = new IntroDirector(sceneStub(), {
      clock: launchClock,
      clockOwnsElapsedTime: true,
      onFrame: (_frame, timeMs) => frameTimes.push(timeMs),
    });

    launchClock.follow(audio);
    const finished = director.play();
    wall.advance(900);
    expect(frameTimes.at(-1)).toBe(0);
    launchClock.followWall();
    wall.advance(100);
    expect(frameTimes.at(-1)).toBe(100);
    advanceRendered(wall, 4_900);
    await finished;
    expect(frameTimes.at(-1)).toBe(5_000);
  });

  it("reports a natural authored completion exactly once", async () => {
    const clock = new ManualClock();
    const completions: IntroCompletion[] = [];
    const director = new IntroDirector(sceneStub(), {
      clock,
      onComplete: (result) => completions.push(result),
    });
    const finished = director.play();
    advanceRendered(clock, 5_000);
    await finished;
    await Promise.resolve();
    expect(completions).toEqual([{ skipped: false, reducedMotion: false }]);
  });

  it("exposes the same authoritative time used by the visual transition", async () => {
    const clock = new ManualClock();
    const frameTimes: number[] = [];
    const director = new IntroDirector(sceneStub(), {
      clock,
      onFrame: (_frame, timeMs) => frameTimes.push(timeMs),
    });
    const finished = director.play();
    advanceRendered(clock, 3_066.667);
    advanceRendered(clock, 166.633);
    advanceRendered(clock, 1_766.7);
    clock.advance(0.001);
    await finished;
    expect(frameTimes[0]).toBe(0);
    expect(frameTimes.some((time) => Math.abs(time - 3_066.667) < 0.001)).toBe(true);
    expect(frameTimes.some((time) => Math.abs(time - 3_233.3) < 0.001)).toBe(true);
    expect(frameTimes.at(-1)).toBe(5_000);
  });

  it("reports skip once even when skip is requested repeatedly", async () => {
    const clock = new ManualClock();
    const completions: IntroCompletion[] = [];
    const director = new IntroDirector(sceneStub(), {
      clock,
      onComplete: (result) => completions.push(result),
    });
    const finished = director.play();
    clock.advance(1_000);
    director.skip();
    director.skip();
    await finished;
    expect(completions).toEqual([{ skipped: true, reducedMotion: false }]);
  });

  it("keeps the captured intro audio while suppressing reduced-motion visual cues", async () => {
    const clock = new ManualClock();
    const cues: string[] = [];
    const completions: IntroCompletion[] = [];
    const director = new IntroDirector(sceneStub(), {
      clock,
      reducedMotion: true,
      onCue: ({ name }) => cues.push(name),
      onComplete: (result) => completions.push(result),
    });
    const finished = director.play();
    advanceRendered(clock, 200);
    await finished;
    await Promise.resolve();
    expect(cues).toEqual(["audio.game-intro"]);
    expect(completions).toEqual([{ skipped: false, reducedMotion: true }]);
  });
});
