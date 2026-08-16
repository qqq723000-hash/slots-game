import { describe, expect, it } from "vitest";
import { resolveInitialRendererSize } from "../src/renderer/PixiRenderer";

describe("resolveInitialRendererSize", () => {
  it("keeps the authored desktop framebuffer by default", () => {
    expect(resolveInitialRendererSize()).toEqual({ width: 1280, height: 720 });
  });

  it("uses the physical mobile/tablet viewport without a desktop allocation", () => {
    expect(resolveInitialRendererSize({ width: 390, height: 844 }))
      .toEqual({ width: 390, height: 844 });
    expect(resolveInitialRendererSize({ width: 1024.4, height: 768.3 }))
      .toEqual({ width: 1024, height: 768 });
  });

  it("fails safe to authored dimensions for invalid host measurements", () => {
    expect(resolveInitialRendererSize({ width: Number.NaN, height: 0 }))
      .toEqual({ width: 1280, height: 720 });
  });
});
