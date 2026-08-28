// @ts-nocheck -- 仅在 Node 中运行的源码与 CSS 契约测试。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const overlayUrl = new URL("../src/ui/DomOverlay.ts", import.meta.url);
const cssUrl = new URL("../src/style.css", import.meta.url);

describe("Pass 131 cross-device independent identity", () => {
  it("renders exactly one code-native independent identity before the metrics", () => {
    const source = readFileSync(overlayUrl, "utf8");
    const panel = source.match(/<section\s+class="status-panel"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(panel.match(/status-panel__identity/g)).toHaveLength(1);
    expect(panel).toContain('aria-label="Independent developer"');
    expect(panel).toContain(">INDIE</span>");
    expect(panel).not.toContain("data-static-image");
    expect(panel.indexOf("status-panel__identity"))
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
    expect(css).toMatch(
      /\.status-panel__identity\s*\{[^}]*display:\s*grid;[^}]*font:[^;]+;[^}]*pointer-events:\s*none;/s,
    );
    expect(css).not.toMatch(/\.status-panel__identity\s*\{[^}]*background-image:/s);
  });
});
