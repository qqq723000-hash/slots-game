import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  parseSpine: vi.fn(),
  loadTexture: vi.fn(),
  disposeTexture: vi.fn(),
}));

vi.mock("../src/renderer/spine/PrimalSpineAssets", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/renderer/spine/PrimalSpineAssets")
  >();
  return { ...original, loadPrimalSpineDataFromVerifiedBinary: mocks.parseSpine };
});

vi.mock("../src/renderer/pixiTextureCleanup", () => ({
  loadPixiTextureFromVerifiedBytes: mocks.loadTexture,
  disposePixiTextureAttempt: mocks.disposeTexture,
}));

import { PRIMAL_ASSETS } from "../src/assets/PrimalAssetManifest";
import {
  FREE_SPIN_VERIFIED_SPINE_KEYS,
  WHEEL_VERIFIED_SPINE_KEYS,
  disposeVerifiedWheelArtwork,
  normalizedVerifiedFeatureAssetPath,
  verifiedFeatureArtworkFromPackage,
} from "../src/renderer/VerifiedFeatureArtwork";
import { primalSpineSkeletonUrl } from "../src/renderer/spine/PrimalSpineAssets";
import type {
  LoadedAssetPackage,
  LoadedAssetResource,
} from "../src/startup/StreamingAssetPackages";

beforeEach(() => {
  mocks.parseSpine.mockReset().mockImplementation(async (key: string) => ({ key }));
  mocks.loadTexture.mockReset()
    .mockImplementation(async (_bytes: Uint8Array, _mime: string) => ({
      baseTexture: {},
      destroy: vi.fn(),
    }));
  mocks.disposeTexture.mockReset();
});

describe("verified Free Spins / Wheel event artwork", () => {
  it("accepts only the configured public asset prefix for a subpath build", () => {
    expect(normalizedVerifiedFeatureAssetPath(
      "/casino/primal/assets/primal-runtime/spine/wheel.skel",
      "/casino/primal/",
    )).toBe("primal-runtime/spine/wheel.skel");
    expect(normalizedVerifiedFeatureAssetPath(
      "/assets/primal-runtime/spine/wheel.skel",
      "/",
    )).toBe(normalizedVerifiedFeatureAssetPath(
      "/casino/primal/assets/primal-runtime/spine/wheel.skel",
      "/casino/primal/",
    ));
    expect(() => normalizedVerifiedFeatureAssetPath(
      "/assets/primal-runtime/spine/wheel.skel",
      "/casino/primal/",
    )).toThrow("Invalid verified feature asset path");
    expect(() => normalizedVerifiedFeatureAssetPath(
      "/casino/primal/assets/primal-runtime/spine/wheel.skel?token=secret",
      "/casino/primal/",
    )).toThrow("Invalid verified feature asset path");
  });

  it("parses all five Free Spins skeletons from verified bytes without a URL fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const loaded = packageFor("desktop", "free-spins", [
      ...FREE_SPIN_VERIFIED_SPINE_KEYS.map((key) => primalSpineSkeletonUrl(key)),
    ]);

    const artwork = await verifiedFeatureArtworkFromPackage(loaded, "free-spins");

    expect(artwork.kind).toBe("free-spins");
    expect(Object.keys(artwork.spines).sort()).toEqual([...FREE_SPIN_VERIFIED_SPINE_KEYS].sort());
    expect(mocks.parseSpine).toHaveBeenCalledTimes(5);
    for (const key of FREE_SPIN_VERIFIED_SPINE_KEYS) {
      expect(mocks.parseSpine).toHaveBeenCalledWith(
        key,
        expect.any(Uint8Array),
        "desktop",
        undefined,
      );
    }
    expect(mocks.loadTexture).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("adopts five Wheel skeletons and three verified PNG attempts, then releases exact owners", async () => {
    const urls = [
      ...WHEEL_VERIFIED_SPINE_KEYS.map((key) => primalSpineSkeletonUrl(key)),
      PRIMAL_ASSETS.features.wheelBlue,
      PRIMAL_ASSETS.features.wheelRed,
      PRIMAL_ASSETS.features.wheelDual,
    ];
    const loaded = packageFor("mobile", "wheel", urls);

    const artwork = await verifiedFeatureArtworkFromPackage(loaded, "wheel");

    expect(artwork.kind).toBe("wheel");
    if (artwork.kind !== "wheel") throw new Error("expected Wheel artwork");
    expect(Object.keys(artwork.spines).sort()).toEqual([...WHEEL_VERIFIED_SPINE_KEYS].sort());
    expect(mocks.parseSpine).toHaveBeenCalledTimes(5);
    expect(mocks.loadTexture).toHaveBeenCalledTimes(3);
    expect(mocks.loadTexture.mock.calls.map(([, mime]) => mime)).toEqual([
      "image/png",
      "image/png",
      "image/png",
    ]);

    disposeVerifiedWheelArtwork(artwork);
    expect(mocks.disposeTexture).toHaveBeenCalledTimes(3);
    expect(new Set(mocks.disposeTexture.mock.calls.map(([texture]) => texture)).size).toBe(3);
  });

  it("rejects an incomplete package with a fixed message before any URL fallback", async () => {
    const loaded = packageFor("desktop", "wheel", [
      ...WHEEL_VERIFIED_SPINE_KEYS.map((key) => primalSpineSkeletonUrl(key)),
      PRIMAL_ASSETS.features.wheelBlue,
      PRIMAL_ASSETS.features.wheelRed,
      // 刻意省略 dual，用于证明不完整包会失败关闭。
    ]);

    await expect(verifiedFeatureArtworkFromPackage(loaded, "wheel"))
      .rejects.toThrow("Verified feature asset package is incomplete");
    expect(mocks.loadTexture).toHaveBeenCalledTimes(2);
    expect(mocks.disposeTexture).toHaveBeenCalledTimes(2);
  });
});

function packageFor(
  channel: "desktop" | "mobile",
  kind: "free-spins" | "wheel",
  urls: readonly string[],
): LoadedAssetPackage {
  const resources = new Map<string, LoadedAssetResource>();
  urls.forEach((url, index) => {
    const bytes = Uint8Array.of(index + 1, index + 2);
    resources.set(`resource-${index}`, Object.freeze({
      spec: Object.freeze({
        id: `resource-${index}`,
        url,
        bytes: bytes.byteLength,
        sha256: "a".repeat(64),
        decoder: "binary",
      }),
      bytes,
      decoded: bytes,
    }));
  });
  return Object.freeze({
    id: `${channel}-feature-${kind}`,
    version: "test",
    stage: "feature-on-demand",
    resources,
  });
}
