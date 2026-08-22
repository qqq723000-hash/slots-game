// @ts-nocheck -- 仅在 Node 中运行的 PNG 与源码契约测试。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const assetUrl = new URL("../public/assets/brand/statusbar-gm-go.png", import.meta.url);
const overlayUrl = new URL("../src/ui/DomOverlay.ts", import.meta.url);
const cssUrl = new URL("../src/style.css", import.meta.url);

describe("Pass 131 cross-device status brand", () => {
  it("locks the user-approved high-resolution RGBA G'm GO source asset", () => {
    const png = readFileSync(assetUrl);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(340);
    expect(png.readUInt32BE(20)).toBe(103);
    // PNG 颜色类型 6 表示带 Alpha 通道的真彩色。
    expect(png[25]).toBe(6);
    expect(createHash("sha256").update(png).digest("hex"))
      .toBe("73c39cc74c061d79d7c4395db3c4ce561d007569e2df8a77d4299ba3883d8295");
  });

  it("renders exactly one non-interactive custom provider before the metrics", () => {
    const source = readFileSync(overlayUrl, "utf8");
    const panel = source.match(/<section\s+class="status-panel"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(source).toContain('publicAssetUrl("assets/brand/statusbar-gm-go.png")');
    expect(panel.match(/status-panel__provider/g)).toHaveLength(1);
    expect(panel).toContain('src="${STATUSBAR_GM_GO}"');
    expect(panel).toContain('alt="G\'m GO"');
    expect(panel.indexOf("status-panel__provider"))
      .toBeLessThan(panel.indexOf("status-metric--balance"));
  });

  it("keeps translucent metric plates mobile-only", () => {
    const css = readFileSync(cssUrl, "utf8");
    const pass = css.slice(css.indexOf("/* 三端状态栏最终合约："));
    expect(pass).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-metric--balance,\s*\.game-frame:not\(\[data-channel="mobile"\]\) \.status-metric--bet\s*\{[^}]*padding:\s*0;[^}]*background:\s*transparent;/s,
    );
    expect(pass).toMatch(
      /\.game-frame\[data-channel="mobile"\] \.status-metric--balance,\s*\.game-frame\[data-channel="mobile"\] \.status-metric--bet\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.15\);/s,
    );
    expect(pass).toMatch(/\.status-metric--win\s*\{[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.status-panel__provider\s*\{[^}]*object-fit:\s*contain;[^}]*pointer-events:\s*none;/s);
  });
});
