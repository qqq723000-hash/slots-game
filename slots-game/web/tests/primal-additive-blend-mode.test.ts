import { BLEND_MODES } from "pixi.js";
import { describe, expect, it } from "vitest";
import {
  createPrimalAdditiveBlendContextListener,
  installPrimalAdditiveBlendMode,
} from "../src/renderer/PixiRenderer";

describe("installPrimalAdditiveBlendMode", () => {
  it("uses the captured Primal ADD factors and preserves render-target alpha", () => {
    const blendModes = Array.from({ length: 4 }, () => [1, 1]);
    const renderer = {
      gl: {
        // 显式提供 WebGLRenderingContext 常量，使其无需分配真实 canvas context / English: Explicitly provide the WebGLRenderingContext constant so that it does not require allocating a real canvas context
        // 也能在 Vitest 中执行。 / English: Can also be executed in Vitest.
        SRC_ALPHA: 0x0302,
        ONE: 1,
        ZERO: 0,
      },
      state: { blendModes },
    };

    expect(installPrimalAdditiveBlendMode(renderer)).toBe(true);
    expect(blendModes[BLEND_MODES.ADD]).toEqual([0x0302, 1, 0, 1]);
  });

  it("does not mutate an incomplete non-WebGL renderer", () => {
    const blendModes = Array.from({ length: 4 }, () => [1, 1]);

    expect(installPrimalAdditiveBlendMode({ state: { blendModes } })).toBe(false);
    expect(blendModes[BLEND_MODES.ADD]).toEqual([1, 1]);
  });

  it("reinstalls the tuple after a WebGL context reset replaces Pixi's table", () => {
    const renderer = {
      gl: { SRC_ALPHA: 0x0302, ONE: 1, ZERO: 0 },
      state: { blendModes: Array.from({ length: 4 }, () => [1, 1]) },
    };
    const listener = createPrimalAdditiveBlendContextListener(renderer);
    expect(installPrimalAdditiveBlendMode(renderer)).toBe(true);

    // Pixi 的 StateSystem.contextChange() 会在恢复时分配一个新映射。 / English: Pixi's StateSystem.contextChange() allocates a new mapping on restore.
    renderer.state.blendModes = Array.from({ length: 4 }, () => [1, 1]);
    listener.contextChange();

    expect(renderer.state.blendModes[BLEND_MODES.ADD]).toEqual([0x0302, 1, 0, 1]);
  });
});
