// @ts-nocheck -- 源码级级联合约测试不依赖浏览器 DOM 实现。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeResponsiveLayoutSnapshot } from "../src/renderer/ResponsiveLayout";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const finalContract = css.slice(css.indexOf("/* 三端状态栏最终合约："));

describe("PC/phone/tablet status typography contract", () => {
  it("locks the 1280x720 PC status metrics to the official desktop projection", () => {
    expect(finalContract).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-panel\s*\{[^}]*height:\s*24px;[^}]*min-height:\s*24px;[^}]*font-family:\s*"ROBOTO_CONDENSED_REGULAR"[^;]*;[^}]*font-size:\s*14\.4px;[^}]*font-weight:\s*400;[^}]*line-height:\s*24px;/s,
    );
    expect(finalContract).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-metric\s*\{[^}]*height:\s*24px;[^}]*gap:\s*0;[^}]*line-height:\s*24px;/s,
    );
    expect(finalContract).toContain("color: #cccccc;");
  });

  it.each([
    { name: "phone", width: 390, height: 844, profile: "pt" },
    { name: "tablet", width: 633, height: 844, profile: "iPad_pt" },
    { name: "rotated phone", width: 844, height: 390, profile: "ls" },
    { name: "rotated tablet", width: 844, height: 633, profile: "ls" },
  ])("uses responsive bold mobile typography for $name", ({ width, height, profile }) => {
    const snapshot = computeResponsiveLayoutSnapshot(width, height, { channel: "mobile" });
    expect(snapshot.mobileProfile).toBe(profile);
    expect(snapshot.statusRegion.height).toBeGreaterThan(0);
    expect(finalContract).toMatch(
      /\.game-frame\[data-channel="mobile"\] \.status-panel\s*\{[^}]*font-family:\s*"ROBOTO_CONDENSED_BOLD"[^;]*;[^}]*font-size:\s*clamp\(12px, 3\.6vw, var\(--mobile-status-font-size\)\);[^}]*font-weight:\s*700;/s,
    );
    expect(finalContract).not.toMatch(
      /data-channel="mobile"[^}]*font-size:\s*14px/s,
    );
  });
});
