import { describe, expect, it } from "vitest";
import {
  IDLE_SPIN_ENVIRONMENT_FRAME,
  addSpinReelImpact,
  beginSpinEnvironment,
  createSpinEnvironmentState,
  finishSpinEnvironment,
  markSpinFastStop,
  resetSpinEnvironment,
  sampleSpinEnvironment,
  triggerFeatureEnvironment,
} from "../src/renderer/spinEnvironmentMotion";

describe("spin environment motion", () => {
  it("starts at an exact identity frame", () => {
    expect(sampleSpinEnvironment(createSpinEnvironmentState(), 0)).toEqual(IDLE_SPIN_ENVIRONMENT_FRAME);
  });

  it("keeps ordinary cruise atmosphere deliberately restrained", () => {
    const state = beginSpinEnvironment(createSpinEnvironmentState(), 100, false);
    const accelerating = sampleSpinEnvironment(state, 220);
    const cruising = sampleSpinEnvironment(state, 500);

    expect(accelerating.spinEnergy).toBeGreaterThan(0);
    expect(accelerating.spinEnergy).toBeLessThan(1);
    expect(cruising.spinEnergy).toBe(1);
    expect(cruising.smokeBoost).toBeLessThanOrEqual(0.08);
    expect(cruising.emberBoost).toBeLessThanOrEqual(0.18);
    expect(cruising.vignetteAlpha).toBeLessThanOrEqual(0.05);
    expect(cruising.warmFlash).toBe(0);
    expect(cruising.floorDust).toBe(0);
  });

  it("returns exactly to identity after the authored finish tail", () => {
    const spinning = beginSpinEnvironment(createSpinEnvironmentState(), 0, false);
    const finishing = finishSpinEnvironment(spinning, 600);

    expect(sampleSpinEnvironment(finishing, 700).spinEnergy).toBeGreaterThan(0);
    expect(sampleSpinEnvironment(finishing, 860)).toEqual(IDLE_SPIN_ENVIRONMENT_FRAME);
    expect(sampleSpinEnvironment(finishing, 4_000)).toEqual(IDLE_SPIN_ENVIRONMENT_FRAME);
  });

  it("localizes and saturates overlapping reel impacts", () => {
    let state = beginSpinEnvironment(createSpinEnvironmentState(), 0, false);
    state = addSpinReelImpact(state, {
      generation: state.generation,
      reel: 2,
      atMs: 300,
      fastForward: false,
    });
    state = addSpinReelImpact(state, {
      generation: state.generation,
      reel: 2,
      atMs: 300,
      fastForward: true,
    });
    const impact = sampleSpinEnvironment(state, 300);

    expect(impact.impactBias).toBe(1);
    expect(impact.warmFlash).toBeGreaterThan(0);
    expect(impact.warmFlash).toBeLessThanOrEqual(0.1);
    expect(impact.floorDust).toBeGreaterThan(0);
    expect(impact.floorDust).toBeLessThanOrEqual(0.14);
    expect(sampleSpinEnvironment(state, 480).warmFlash).toBe(0);
  });

  it("compresses fast-stop energy without creating a background flash", () => {
    const spinning = beginSpinEnvironment(createSpinEnvironmentState(), 0, false);
    const fast = markSpinFastStop(spinning, 400);
    const frame = sampleSpinEnvironment(fast, 510);

    expect(frame.spinEnergy).toBeLessThan(1);
    expect(frame.warmFlash).toBe(0);
    expect(markSpinFastStop(fast, 600)).toBe(fast);
  });

  it("ignores impacts from a stale presentation generation", () => {
    const first = beginSpinEnvironment(createSpinEnvironmentState(), 0, false);
    const second = beginSpinEnvironment(first, 1_000, false);
    const stale = addSpinReelImpact(second, {
      generation: first.generation,
      reel: 0,
      atMs: 1_100,
      fastForward: false,
    });

    expect(stale).toBe(second);
    expect(sampleSpinEnvironment(stale, 1_100).warmFlash).toBe(0);
  });

  it("gives decoded feature cues priority over base cruise", () => {
    const spinning = beginSpinEnvironment(createSpinEnvironmentState(), 0, false);
    const wheel = triggerFeatureEnvironment(spinning, {
      kind: "wheel",
      atMs: 500,
      durationMs: 1_000,
      reducedMotion: false,
    });
    const wheelFrame = sampleSpinEnvironment(wheel, 1_000);

    expect(wheelFrame.featureAura).toBeGreaterThan(0.9);
    expect(wheelFrame.eyeBoost).toBeGreaterThan(0.7);
    expect(wheelFrame.vignetteAlpha).toBeGreaterThan(0.1);

    const vault = triggerFeatureEnvironment(spinning, {
      kind: "vault",
      atMs: 500,
      durationMs: 1_000,
      reducedMotion: false,
      bias: -1,
    });
    const vaultFrame = sampleSpinEnvironment(vault, 1_000);
    expect(vaultFrame.impactBias).toBe(-1);
    expect(vaultFrame.floorDust).toBeGreaterThan(0.4);
  });

  it("removes spatial atmosphere and limits reduced-motion light to 90ms", () => {
    let state = beginSpinEnvironment(createSpinEnvironmentState(), 0, true);
    state = addSpinReelImpact(state, {
      generation: state.generation,
      reel: 0,
      atMs: 20,
      fastForward: false,
    });
    state = triggerFeatureEnvironment(state, {
      kind: "wheel",
      atMs: 20,
      durationMs: 140,
      reducedMotion: true,
    });
    const active = sampleSpinEnvironment(state, 20);

    expect(active.spinEnergy).toBe(0);
    expect(active.smokeBoost).toBe(0);
    expect(active.emberBoost).toBe(0);
    expect(active.floorDust).toBe(0);
    expect(active.impactBias).toBe(0);
    expect(active.warmFlash).toBeLessThanOrEqual(0.06);
    expect(active.featureAura).toBeLessThanOrEqual(0.06);
    expect(sampleSpinEnvironment(state, 110)).toEqual(IDLE_SPIN_ENVIRONMENT_FRAME);
  });

  it("reset invalidates active spin, impacts, and feature cues", () => {
    let state = beginSpinEnvironment(createSpinEnvironmentState(), 0, false);
    state = addSpinReelImpact(state, {
      generation: state.generation,
      reel: 1,
      atMs: 300,
      fastForward: false,
    });
    state = triggerFeatureEnvironment(state, {
      kind: "rage",
      atMs: 300,
      durationMs: 800,
      reducedMotion: false,
    });
    const reset = resetSpinEnvironment(state);

    expect(reset.generation).toBe(state.generation + 1);
    expect(sampleSpinEnvironment(reset, 400)).toEqual(IDLE_SPIN_ENVIRONMENT_FRAME);
  });
});
