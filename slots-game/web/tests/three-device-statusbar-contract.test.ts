// @ts-nocheck -- 源码级级联合约测试不依赖浏览器 DOM 实现。 / English: @ts-nocheck -- Source code level cascade contract testing does not rely on browser DOM implementation.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeResponsiveLayoutSnapshot } from "../src/renderer/ResponsiveLayout";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
const officialStatusbar = readFileSync(
  new URL("../public/assets/primal-runtime/interface/statusbar.json", import.meta.url),
  "utf8",
);
const officialMobileConfig = readFileSync(
  new URL("../public/assets/primal-runtime/mobile/config/config_mobile.json", import.meta.url),
  "utf8",
);
const finalContract = css.slice(css.indexOf("/* 三端状态栏最终合约："));

describe("PC/phone/tablet status typography contract", () => {
  it("registers the official dedicated bold face without synthesizing another weight", () => {
    expect(officialMobileConfig)
      .toContain('"name":"DefaultFont","font":"ROBOTO_CONDENSED_BOLD"');
    expect(css).toMatch(
      /@font-face\s*\{[^}]*font-family:\s*"ROBOTO_CONDENSED_BOLD";[^}]*ROBOTO_CONDENSED_BOLD\.woff[^}]*font-style:\s*normal;[^}]*font-weight:\s*normal;/s,
    );
  });

  it("preserves the source ASCII space between every caption and value", () => {
    for (const caption of ["Balance", "Bet", "Win"]) {
      expect(officialStatusbar).toMatch(
        new RegExp(`"txt": "${caption}: \\$[^"\\n]+"[\\s\\S]{0,120}"fnt": "\\? \\? 18px ROBOTO_CONDENSED_REGULAR"`),
      );
      expect(overlaySource).toContain(
        `<span class="status-metric__label">${caption}:&#32;</span>`,
      );
    }
    expect(finalContract).toMatch(
      /\.status-metric__label\s*\{[^}]*white-space:\s*pre;/s,
    );
  });

  it("locks the complete 1280x720 PC footer to one coherent 16px projection", () => {
    expect(finalContract).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-panel\s*\{[^}]*height:\s*16px;[^}]*min-height:\s*16px;[^}]*box-shadow:\s*0 -1px 0 #130a03;[^}]*font-family:\s*"ROBOTO_CONDENSED_REGULAR"[^;]*;[^}]*font-size:\s*12\.8px;[^}]*font-weight:\s*400;[^}]*line-height:\s*16px;/s,
    );
    expect(finalContract).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-metric\s*\{[^}]*height:\s*16px;[^}]*gap:\s*3px;[^}]*line-height:\s*16px;/s,
    );
    expect(finalContract).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-panel__identity\s*\{[^}]*left:\s*4px;[^}]*width:\s*45\.3333px;[^}]*height:\s*13\.3333px;/s,
    );
    expect(finalContract).toContain(
      '.game-frame:not([data-channel="mobile"]) .status-metric--balance { left: 56px; }',
    );
    expect(finalContract).toContain(
      '.game-frame:not([data-channel="mobile"]) .status-metric--bet { left: 165px; }',
    );
    expect(finalContract).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-panel__game\s*\{[^}]*right:\s*6px;[^}]*height:\s*16px;[^}]*font:\s*400 8px\/16px/s,
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
      /\.game-frame\[data-channel="mobile"\] \.status-panel\s*\{[^}]*font-family:\s*"ROBOTO_CONDENSED_BOLD",\s*"Primal Roboto Condensed"[^;]*;[^}]*font-size:\s*clamp\(12px, 3\.6cqw, var\(--mobile-status-font-size\)\);[^}]*font-style:\s*normal;[^}]*font-weight:\s*normal;[^}]*letter-spacing:\s*0;[^}]*text-transform:\s*none;/s,
    );
    expect(finalContract).not.toMatch(
      /data-channel="mobile"[^}]*font-size:\s*14px/s,
    );
  });
});
