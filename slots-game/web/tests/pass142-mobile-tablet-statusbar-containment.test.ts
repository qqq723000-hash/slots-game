// @ts-nocheck -- 仅在 Node 中运行的源码与资源契约测试。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeResponsiveLayoutSnapshot } from "../src/renderer/ResponsiveLayout";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const logo = readFileSync(
  new URL("../public/assets/brand/statusbar-gm-go.png", import.meta.url),
);

const targets = [
  { width: 390, height: 844, profile: "pt", top: 760, statusHeight: 84 },
  { width: 844, height: 390, profile: "ls", top: 372, statusHeight: 18 },
  { width: 768, height: 1_024, profile: "iPad_pt", top: 922, statusHeight: 102 },
  { width: 1_024, height: 768, profile: "ls", top: 732, statusHeight: 36 },
] as const;

describe("Pass 142 mobile/tablet status-bar containment", () => {
  it.each(targets)(
    "keeps the authored $width x $height status region inside the viewport",
    ({ width, height, profile, top, statusHeight }) => {
      const snapshot = computeResponsiveLayoutSnapshot(width, height, {
        channel: "mobile",
      });
      expect(snapshot.mobileProfile).toBe(profile);
      expect(snapshot.statusRegion).toEqual({
        left: 0,
        top,
        width,
        height: statusHeight,
      });
      expect(snapshot.statusRegion.top + snapshot.statusRegion.height).toBe(height);
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
    "keeps the scaled landscape provider clear of Balance at $width x $height",
    ({ width, statusHeight }) => {
      const scale = statusHeight / 25.7142857143;
      const provider = {
        left: width * 0.004,
        width: 68 * scale,
        height: 20 * scale,
      };
      const balanceLeft = statusHeight * 3.05;
      expect(provider.left).toBeGreaterThanOrEqual(0);
      expect(provider.height).toBeLessThanOrEqual(statusHeight);
      expect(provider.left + provider.width).toBeLessThan(balanceLeft);
      expect(balanceLeft).toBeLessThan(width);
    },
  );

  it("retains the exact user-approved G'm GO source", () => {
    expect(logo.readUInt32BE(16)).toBe(340);
    expect(logo.readUInt32BE(20)).toBe(103);
    expect(logo[25]).toBe(6);
    expect(createHash("sha256").update(logo).digest("hex"))
      .toBe("73c39cc74c061d79d7c4395db3c4ce561d007569e2df8a77d4299ba3883d8295");
  });
});
