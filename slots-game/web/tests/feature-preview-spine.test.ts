// @ts-expect-error Vitest 在 Node 中运行；浏览器生产版 tsconfig 刻意省略 Node 全局类型。 / English: @ts-expect-error Vitest runs in Node; the browser production version tsconfig deliberately omits the Node global type.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FEATURE_PREVIEW_CONTENT_BOUNDS,
  FEATURE_PREVIEW_CONTENT_REGIONS,
  FEATURE_PREVIEW_BACKGROUND_POSE,
  FEATURE_PREVIEW_BACKGROUND_TRANSFORM,
  FEATURE_PREVIEW_PLATE_REGION,
  FEATURE_PREVIEW_PLAYBACK_MS,
  FEATURE_PREVIEW_SPINE_TRANSFORM,
  FEATURE_PREVIEW_UI_ATLAS,
} from "../src/renderer/FeaturePreviewSpineView";
import { PRIMAL_BACKGROUND_STAGE_TRANSFORM } from "../src/renderer/CityBackdrop";

describe("authored feature preview", () => {
  it("centres the captured 1200x900 background on the desktop stage", () => {
    expect(PRIMAL_BACKGROUND_STAGE_TRANSFORM).toEqual({
      x: 640,
      y: 360,
      scale: 0.8,
    });
    expect(FEATURE_PREVIEW_BACKGROUND_POSE).toEqual({
      backdropSeconds: 2.36,
      foregroundSeconds: 0,
    });
    expect(FEATURE_PREVIEW_BACKGROUND_TRANSFORM).toEqual({
      x: 626,
      y: 309,
      scale: 1.128,
    });
  });

  it("uses the captured adaptive fpContent transform", () => {
    expect(FEATURE_PREVIEW_SPINE_TRANSFORM).toEqual({
      x: 655.709_091,
      y: 321.872_727,
      scale: 0.733_091,
    });
  });

  it("locks the captured preview plate, track lengths and UI atlas regions", () => {
    expect(FEATURE_PREVIEW_PLATE_REGION).toEqual({
      x: 0,
      y: 824,
      width: 640,
      height: 640,
      displaySize: 1_600,
    });
    expect(FEATURE_PREVIEW_PLAYBACK_MS).toEqual({
      placeholderFade: 700,
      contentPlaceholderHold: 1_000 / 30,
      contentPlaceholderFade: 3_000 / 30,
      show: 500,
      loop: 5_333.333,
      wheelLoop: 10_833.333,
    });
    expect(FEATURE_PREVIEW_CONTENT_REGIONS).toEqual({
      vignette: { x: 0, y: 0, width: 820, height: 820 },
      divider: { x: 824, y: 0, width: 8, height: 492 },
      wheelPlaceholder: { x: 644, y: 1_228, width: 352, height: 352 },
      reelsPlaceholder: { x: 644, y: 824, width: 316, height: 400 },
    });
    expect(FEATURE_PREVIEW_CONTENT_BOUNDS).toEqual({
      vignette: { x: 305.527, y: -2.553, width: 668.946, height: 668.946 },
      divider: { x: 638.036, y: 168.284, width: 3.927, height: 402.545 },
      wheelPlaceholder: { x: 330.073, y: 188.902, width: 286.036, height: 286.036 },
      reelsPlaceholder: { x: 682.153, y: 179.215, width: 257.891, height: 324.655 },
    });
    expect(FEATURE_PREVIEW_UI_ATLAS).toMatchObject({
      defaultX: 380,
      hoverX: 608,
      downX: 836,
      buttonWidth: 224,
      buttonHeight: 44,
      sweepDurationMs: 1_500,
      sweepHoldEndFrame: 8,
      sweepTravelEndFrame: 29,
      sweepTotalFrames: 45,
    });
  });

  it("uses dark, green-hover and pressed atlas states plus the 45-frame sweep", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toContain('.feature-preview[data-authored="true"] .feature-preview__city');
    expect(css).toContain("background-position: -380px 0;");
    expect(css).toContain("background-position: -608px 0;");
    expect(css).toContain("background-position: -836px 0;");
    expect(css).toContain("animation: feature-preview-button-sweep 1.5s linear infinite;");
    expect(css).toContain('font-family: "Primal Kanit"');
    expect(css).toContain("font-size: 24px;");
    expect(css).toContain("-webkit-text-stroke: 6.545px #000;");
    expect(css).toContain("width: 26.88px;");
    expect(css).toContain("right: calc(var(--visible-inset-x, 0px) + 27px);");
    expect(css).toContain("0%, 17.777%");
    expect(css).toContain("64.444%, 100%");
  });

  it("keeps the captured English feature-preview copy", () => {
    const overlay = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    expect(overlay).toContain("Spin the wheel and win<br />big!");
    expect(overlay).toContain("Conquer the reels in<br />Expanding Free Spins!");
    expect(overlay).not.toContain("win up to X1000");
  });

  it("hides the splash immediately before the authored intro starts", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /\.feature-preview\s*\{[^}]*transition:\s*none;/s,
    );
  });

  it("renders a code-native independent-development caption", () => {
    const overlay = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    expect(overlay).toContain(
      '<p class="launcher-independent">Independent developer build</p>',
    );
    expect(overlay).not.toContain("assets/brand/");
    expect(overlay).not.toMatch(/launcher-independent[^>]*data-static-image/);
    expect(overlay).not.toMatch(/<i[^>]*--statusbar-texture/);
  });

  it("locks the final authored mark bounds and caption anchor without later overrides", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    const independentRules = [...css.matchAll(/\.launcher-independent\s*\{([^}]*)\}/g)];
    const captionRule = css.match(
      /\.feature-preview\[data-authored="true"\] \.feature-card__copy\s*\{([^}]*)\}/,
    );

    expect(independentRules).toHaveLength(1);
    expect(independentRules[0]?.[1]).toMatch(/left:\s*50%;/);
    expect(independentRules[0]?.[1]).toMatch(/bottom:\s*7\.2px;/);
    expect(independentRules[0]?.[1]).toMatch(/width:\s*140\.4px;/);
    expect(independentRules[0]?.[1]).toMatch(/height:\s*52\.8px;/);
    expect(independentRules[0]?.[1]).toMatch(/transform:\s*translateX\(-50%\);/);
    expect(independentRules[0]?.[1]).toMatch(/text-transform:\s*uppercase;/);
    expect(independentRules[0]?.[1]).not.toMatch(/object-fit:/);
    expect(captionRule?.[1]).toMatch(/top:\s*509px;/);
    expect(captionRule?.[1]).not.toMatch(/top:\s*499px;/);
  });

  it("ships the captured UI fonts instead of no-content placeholders", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toContain('font-family: "Primal Kanit";');
    expect(css).toContain('/assets/primal-runtime/fonts/KANIT_BOLD.woff');
    expect(css).toContain('font-family: "Primal Roboto Condensed";');
    expect(css).toContain('/assets/primal-runtime/fonts/ROBOTO_CONDENSED_BOLD.woff');

    for (const fontName of ["KANIT_BOLD.woff", "ROBOTO_CONDENSED_BOLD.woff"]) {
      const font = readFileSync(
        new URL(`../public/assets/primal-runtime/fonts/${fontName}`, import.meta.url),
      );
      expect(["wOFF", "wOF2"]).toContain(font.subarray(0, 4).toString("ascii"));
      expect(font.readUInt32BE(8)).toBe(font.byteLength);
      expect(font.byteLength).toBeGreaterThan(1_024);
    }
  });
});
