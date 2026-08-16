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
});
