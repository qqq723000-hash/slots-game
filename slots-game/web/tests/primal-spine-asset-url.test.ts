import { describe, expect, it } from "vitest";
import { resolvePrimalSpineAtlasPageUrl } from "../src/renderer/spine/PrimalSpineAssets";

describe("Primal Spine atlas page URL boundary", () => {
  it("resolves only the fixed desktop and mobile AVIF page families", () => {
    expect(resolvePrimalSpineAtlasPageUrl(
      "spine_symbols",
      "desktop",
      "spine_symbols_level1_3.avif",
    )).toMatch(/\/spine_symbols\/spine_symbols_level1_3\.avif$/u);
    expect(resolvePrimalSpineAtlasPageUrl(
      "spine_ui",
      "mobile",
      "spine_ui_level2.avif",
    )).toMatch(/\/spine_ui\/spine_ui_level2\.avif$/u);
    expect(resolvePrimalSpineAtlasPageUrl(
      "spine_background",
      "mobile",
      "spine_background_level2_2.avif",
    )).toMatch(/\/spine_background\/spine_background_level2_2\.avif$/u);
  });

  it.each([
    "../wallet/session",
    "https://attacker.invalid/page.avif",
    "//attacker.invalid/page.avif",
    "spine_ui_level1.avif?token=secret",
    "spine_ui_level1.avif#fragment",
    "spine_ui_level1.png",
    "spine_symbols_level1_4.avif",
    "spine_symbols_level2.avif",
    "spine_symbols_level1_1000.avif",
    "spine_symbols_level1\\evil.avif",
  ])("rejects an unreviewed desktop atlas page: %s", (page) => {
    expect(() => resolvePrimalSpineAtlasPageUrl("spine_symbols", "desktop", page))
      .toThrow("Invalid Primal Spine atlas page");
  });
});
