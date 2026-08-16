import { describe, expect, it, vi } from "vitest";
import { Texture } from "pixi.js";
import {
  PreloadGate,
  type PreloadProgress,
} from "../src/startup/PreloadGate";

const spineLoader = vi.hoisted(() => ({
  loadSet: vi.fn(),
}));

vi.mock("../src/renderer/spine/PrimalSpineAssets", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/renderer/spine/PrimalSpineAssets")
  >();
  return {
    ...original,
    loadPrimalSpineSet: spineLoader.loadSet,
  };
});

import { loadFeatureTextures } from "../src/renderer/FeatureEffects";

const REQUIRED_FEATURE_SPINES = Object.freeze([
  "wheel",
  "trail",
  "wheelPopupStart",
  "wheelSummaryFreespins",
  "wheelSummaryJackpot",
  "freeSpinIntroKongQuest",
  "freeSpinIntroKingSpin",
  "freeSpinSummary",
] as const);

describe("strict authored feature preload", () => {
  it("fails the entry-critical gate on a required Wheel Spine error and remains retryable", async () => {
    vi.spyOn(Texture, "fromURL").mockResolvedValue(Texture.EMPTY);
    spineLoader.loadSet
      .mockRejectedValueOnce(new Error("wheel atlas corrupt"))
      .mockImplementationOnce(async (keys: readonly string[]) => Object.fromEntries(
        keys.map((key) => [key, { testSpineData: key }]),
      ));

    const progress: PreloadProgress[] = [];
    const gate = new PreloadGate([{
      name: "entry-critical-resources",
      stage: "assets",
      weight: 1,
      run: () => loadFeatureTextures(),
    }]);

    await expect(gate.run((event) => progress.push(event))).rejects.toThrow(
      'Preload task "entry-critical-resources" failed: wheel atlas corrupt',
    );
    expect(progress.every((event) => event.progress < 1)).toBe(true);
    expect(progress.every((event) => event.status !== "complete")).toBe(true);
    expect(spineLoader.loadSet).toHaveBeenNthCalledWith(1, REQUIRED_FEATURE_SPINES);

    await expect(loadFeatureTextures()).resolves.toBeUndefined();
    expect(spineLoader.loadSet).toHaveBeenNthCalledWith(2, REQUIRED_FEATURE_SPINES);
  });
});
