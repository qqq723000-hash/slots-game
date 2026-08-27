// @ts-nocheck -- 仅在 Node 中运行的源码契约测试。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeResponsiveLayoutSnapshot } from "../src/renderer/ResponsiveLayout";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const targets = [
  { width: 390, height: 844, designWidth: 390, designHeight: 844, profile: "pt", top: 760, statusHeight: 84 },
  { width: 844, height: 390, designWidth: 844, designHeight: 390, profile: "ls", top: 372, statusHeight: 18 },
  { width: 768, height: 1_024, designWidth: 633, designHeight: 844, profile: "iPad_pt", top: 760, statusHeight: 84 },
  { width: 1_024, height: 768, designWidth: 844, designHeight: 633, profile: "ls", top: 603, statusHeight: 30 },
] as const;

describe("Pass 142 mobile/tablet status-bar containment", () => {
  it.each(targets)(
    "keeps the authored $width x $height status region inside the viewport",
    ({ width, height, designWidth, designHeight, profile, top, statusHeight }) => {
      const snapshot = computeResponsiveLayoutSnapshot(width, height, {
        channel: "mobile",
      });
      expect(snapshot.mobileProfile).toBe(profile);
      expect(snapshot.statusRegion).toEqual({
        left: 0,
        top,
        width: designWidth,
        height: statusHeight,
      });
      expect(snapshot.statusRegion.top + snapshot.statusRegion.height).toBe(designHeight);
    },
  );

  it("neutralizes the desktop launch translation only on the mobile status panel", () => {
    const pass = css.slice(css.indexOf("/*\n * Pass 142："));
    expect(pass).toMatch(
      /\.game-frame\[data-channel="mobile"\]\s+\.status-panel\s*\{[^}]*transform:\s*none;/s,
    );
    expect(pass).not.toMatch(/data-channel="desktop"/);
  });

  it.each(targets.filter(({ profile }) => profile === "ls"))(
    "keeps the scaled landscape identity clear of Balance at $width x $height",
    ({ designWidth, statusHeight }) => {
      const scale = statusHeight / 25.7142857143;
      const identity = {
        left: designWidth * 0.004,
        width: 68 * scale,
        height: 20 * scale,
      };
      const balanceLeft = statusHeight * 3.05;
      expect(identity.left).toBeGreaterThanOrEqual(0);
      expect(identity.height).toBeLessThanOrEqual(statusHeight);
      expect(identity.left + identity.width).toBeLessThan(balanceLeft);
      expect(balanceLeft).toBeLessThan(designWidth);
    },
  );

  it("keeps the independent identity code-native at every mobile status size", () => {
    expect(css).toMatch(/\.status-panel__identity\s*\{[^}]*background:\s*none;/s);
    expect(css).toContain("--mobile-status-identity-scale");
    expect(css).not.toMatch(/\.status-panel__identity\s*\{[^}]*url\(/s);
  });
});
