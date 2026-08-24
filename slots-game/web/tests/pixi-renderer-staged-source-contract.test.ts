import { describe, expect, it } from "vitest";
import {
  PIXI_RENDERER_CONSTRUCTION_STAGE_IDS,
} from "../src/renderer/PixiRenderer";

describe("PixiRenderer staged construction source contract", () => {
  it("puts substantive final owners on distinct one-owner stages", () => {
    expect(PIXI_RENDERER_CONSTRUCTION_STAGE_IDS).toContain("reel-cabinet");
    expect(PIXI_RENDERER_CONSTRUCTION_STAGE_IDS).toContain("city-backdrop");
    expect(PIXI_RENDERER_CONSTRUCTION_STAGE_IDS).toContain("big-win-overlay");
    expect(PIXI_RENDERER_CONSTRUCTION_STAGE_IDS).toContain("launch-scene");
    expect(new Set(PIXI_RENDERER_CONSTRUCTION_STAGE_IDS).size)
      .toBe(PIXI_RENDERER_CONSTRUCTION_STAGE_IDS.length);
    expect(PIXI_RENDERER_CONSTRUCTION_STAGE_IDS.at(-1)).toBe("renderer-graph");
  });

  it("keeps the eager constructor as rollback while staged construction injects owners", async () => {
    const source = await import("../src/renderer/PixiRenderer.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));
    expect(source).toContain("stagedOwners?: PixiRendererOwners");
    expect(source).toContain("stagedOwners ?? createEagerPixiRendererOwners(options)");
    expect(source).toContain("new PixiRenderer(host, options, requireRendererOwners(state))");
    expect(source).not.toContain('id: "reel-cabinet-preflight"');
    expect(source).not.toContain('id: "city-backdrop-preflight"');
  });

  it("does not publish completion until exact final-owner adoption", async () => {
    const source = await import("../src/renderer/PixiRenderer.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));
    const factory = source.slice(
      source.indexOf("static async createStaged("),
      source.indexOf("async loadCriticalAssets("),
    );
    expect(factory.indexOf("state.adopted = true"))
      .toBeLessThan(factory.indexOf("construction.onProgress?.(1)"));
    expect(factory.indexOf("ownership.release()"))
      .toBeLessThan(factory.indexOf("construction.onProgress?.(1)"));
  });

  it("keeps Big Win exclusive artwork out of strict startup load and GPU warmup", async () => {
    const source = await import("../src/renderer/PixiRenderer.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));
    const critical = source.slice(
      source.indexOf("async loadCriticalAssets("),
      source.indexOf("setVisualTelemetryListener("),
    );
    const warmup = source.slice(
      source.indexOf("async warmCriticalAssets("),
      source.indexOf("private markGpuWarmupStage("),
    );

    expect(critical).not.toContain("this.bigWin.loadArtwork");
    expect(critical).not.toContain('id: "win.big"');
    expect(warmup).not.toContain("BIG_WIN_COIN_ATLAS_URL");
    expect(warmup).not.toContain('["big-win"');
  });

  it("keeps Free Spins and Wheel event artwork out of strict startup load and GPU warmup", async () => {
    const source = await import("../src/renderer/PixiRenderer.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));
    const critical = source.slice(
      source.indexOf("async loadCriticalAssets("),
      source.indexOf("setVisualTelemetryListener("),
    );
    const warmup = source.slice(
      source.indexOf("async warmCriticalAssets("),
      source.indexOf("private markGpuWarmupStage("),
    );

    expect(critical).not.toContain("this.freeSpinHud.loadArtwork");
    expect(critical).not.toContain('sourceEvent: "launch.preload",\n      }, () => this.freeSpinHud');
    expect(warmup).not.toContain('["free-spin"');
    expect(warmup).not.toContain("this.freeSpinHud,");
    expect(source).toContain("verifiedFeatureArtworkFromPackage(loaded, kind, signal)");
    expect(source).toContain("this.featureEffects.adoptVerifiedWheelArtwork(artwork)");
    expect(source).toContain("this.freeSpinHud.loadArtwork(signal, artwork)");
  });

  it("starts feature leases before accepted state transitions and releases each true lifetime", async () => {
    const source = await import("../src/app/AppController.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));
    const acceptance = source.slice(
      source.indexOf("private acceptSpinResult("),
      source.indexOf("private acknowledgePresentedSpinResult("),
    );
    expect(acceptance.indexOf("this.primeAuthoritativeFeatureAssetLeases("))
      .toBeLessThan(acceptance.indexOf('this.markRgsResultDeliveryStage("reel-transition")'));
    expect(acceptance.indexOf("this.primeAuthoritativeFeatureAssetLeases("))
      .toBeLessThan(acceptance.indexOf('this.markRgsResultDeliveryStage("feature-transition")'));
    expect(source).toContain("if (this.wheelAssetLease && result.events.some");
    expect(source).toContain('this.releaseFeatureAssetEventLease("wheel")');
    expect(source).toContain('result.featureState.mode === "BASE"');
    expect(source).toContain('this.releaseFeatureAssetEventLease("free-spins")');
  });

  it("holds the verified event lease through direct Big Win payload consumption", async () => {
    const source = await import("../src/app/AppController.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));
    const branch = source.slice(
      source.indexOf("if (bigWinPlan) {"),
      source.indexOf("// 通用 WinLogic", source.indexOf("if (bigWinPlan) {")),
    );
    expect(branch.indexOf("this.beginBigWinAssetEventLease()"))
      .toBeLessThan(branch.indexOf("BIG_WIN_CONTROLLER_LEAD_IN_MS"));
    expect(branch).toContain("bigWinVerifiedArtworkFromPackage((await assetLease.ready).package)");
    expect(branch).toContain("verifiedArtwork");
    expect(branch.indexOf("this.renderer.bigWin.present("))
      .toBeLessThan(branch.lastIndexOf("assetLease?.release()"));
  });
});
