import { describe, expect, it } from "vitest";
import {
  shouldUseAuthoredPrimalSpine,
  shouldUsePrimalAudioSprites,
  type PrimalRuntimeCapabilities,
} from "../src/assets/primalRuntimePolicy";

const desktop: PrimalRuntimeCapabilities = {
  mode: "auto",
  viewportWidth: 1_280,
  viewportHeight: 720,
  coarsePointer: false,
  deviceMemoryGb: 8,
  hardwareConcurrency: 8,
  maxTextureSize: 8_192,
};

describe("Primal runtime capability policy", () => {
  it("keeps the exact authored desktop presentation on capable hardware", () => {
    expect(shouldUseAuthoredPrimalSpine(desktop)).toBe(true);
    expect(shouldUsePrimalAudioSprites(desktop)).toBe(true);
  });

  it("uses fallbacks when the GPU cannot hold the supplied atlas pages", () => {
    expect(shouldUseAuthoredPrimalSpine({ ...desktop, maxTextureSize: 2_048 })).toBe(false);
  });

  it("keeps required Spine motion on low-memory and coarse-pointer devices", () => {
    expect(shouldUseAuthoredPrimalSpine({ ...desktop, deviceMemoryGb: 4 })).toBe(true);
    expect(shouldUsePrimalAudioSprites({
      ...desktop,
      viewportWidth: 844,
      coarsePointer: true,
      deviceMemoryGb: null,
    })).toBe(false);
  });

  it("uses authored Level2 Spine on phone and tablet channels", () => {
    const compactMobile = {
      ...desktop,
      viewportWidth: 390,
      viewportHeight: 844,
      coarsePointer: true,
      deviceMemoryGb: 4,
      hardwareConcurrency: 4,
      maxTextureSize: 4_096,
    };
    expect(shouldUseAuthoredPrimalSpine(compactMobile)).toBe(true);
    expect(shouldUsePrimalAudioSprites(compactMobile)).toBe(false);
    expect(shouldUseAuthoredPrimalSpine(compactMobile, "mobile")).toBe(true);
    expect(shouldUsePrimalAudioSprites(compactMobile, "mobile")).toBe(true);
    expect(shouldUseAuthoredPrimalSpine({ ...compactMobile, deviceMemoryGb: 2 }, "mobile"))
      .toBe(true);
    expect(shouldUsePrimalAudioSprites({ ...compactMobile, hardwareConcurrency: 2 }, "mobile"))
      .toBe(false);
  });

  it("honours explicit operator overrides", () => {
    const constrained = {
      ...desktop,
      mode: "force" as const,
      deviceMemoryGb: 2,
      maxTextureSize: 2_048,
    };
    expect(shouldUseAuthoredPrimalSpine(constrained)).toBe(true);
    expect(shouldUsePrimalAudioSprites(constrained)).toBe(true);
    expect(shouldUseAuthoredPrimalSpine({ ...desktop, mode: "off" })).toBe(false);
  });
});
