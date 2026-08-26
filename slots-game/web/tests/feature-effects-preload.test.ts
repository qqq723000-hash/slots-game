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

const REQUIRED_INTERACTION_SPINES = Object.freeze(["trail"] as const);

describe("strict authored feature preload", () => {
  it("loads only the shared interaction trail at startup and remains retryable", async () => {
    vi.spyOn(Texture, "fromURL").mockResolvedValue(Texture.EMPTY);
    spineLoader.loadSet
      .mockRejectedValueOnce(new Error("interaction atlas corrupt"))
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
      'Preload task "entry-critical-resources" failed: interaction atlas corrupt',
    );
    expect(progress.every((event) => event.progress < 1)).toBe(true);
    expect(progress.every((event) => event.status !== "complete")).toBe(true);
    expect(spineLoader.loadSet).toHaveBeenNthCalledWith(1, REQUIRED_INTERACTION_SPINES);

    await expect(loadFeatureTextures()).resolves.toBeUndefined();
    expect(spineLoader.loadSet).toHaveBeenNthCalledWith(2, REQUIRED_INTERACTION_SPINES);
    expect(Texture.fromURL).toHaveBeenCalledTimes(2);
    expect(Texture.fromURL).not.toHaveBeenCalledWith(
      expect.stringMatching(/1002(?:3|6|7)\.png$/),
    );
  });
});
