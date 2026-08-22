// @ts-nocheck -- 仅在 Node 中运行的源码与 PNG 契约测试。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import overlaySource from "../src/ui/DomOverlay.ts?raw";

const BRAND_PATH = "assets/brand/powered-by-gm-go.png";
const loadingCss = readFileSync(
  new URL("../src/loading-official.css", import.meta.url),
  "utf8",
);

function pngDimensions(bytes: Buffer): readonly [number, number] {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("Pass 127 official responsive loading brand", () => {
  it("ships the approved 500x188 G'm GO alpha asset in both startup shells", () => {
    const mark = readFileSync(new URL(`../public/${BRAND_PATH}`, import.meta.url));

    expect(pngDimensions(mark)).toEqual([500, 188]);
    expect(mark.byteLength).toBeGreaterThan(20_000);
    expect(indexHtml).toContain(`src="${BRAND_PATH}"`);
    expect(indexHtml).toContain("Powered by G'm GO");
    expect(overlaySource).toContain(`publicAssetUrl("${BRAND_PATH}")`);
    expect(overlaySource).toContain('aria-label="Powered by G\'m GO"');
    expect(indexHtml).not.toContain("primal-rampage-logo.png");
  });

  it("loads the authoritative override after the legacy game stylesheet", () => {
    const legacy = indexHtml.indexOf('href="/src/style.css"');
    const official = indexHtml.indexOf('href="/src/loading-official.css"');

    expect(legacy).toBeGreaterThanOrEqual(0);
    expect(official).toBeGreaterThan(legacy);
  });

  it("owns loading in the physical viewport instead of the late-scaled 1280x720 frame", () => {
    expect(loadingCss).toMatch(
      /\.launch-loading-host\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
    );
    expect(loadingCss).toMatch(/\.launch-loading-host\s*\{[^}]*pointer-events:\s*none;/s);
  });

  it("only intercepts player input while the loading barrier is visible", () => {
    expect(loadingCss).toMatch(
      /\.launch-loading\s*\{[^}]*pointer-events:\s*none;/s,
    );
    expect(loadingCss).toMatch(
      /\.launch-loading\[data-visible="true"\]\s*\{[^}]*pointer-events:\s*auto;/s,
    );
  });

  it("locks the official colour, track geometry and 500ms progress easing", () => {
    expect(loadingCss).toContain("background: radial-gradient(#002448, #000e20);");
    expect(loadingCss).toContain("width: 26%;");
    expect(loadingCss).toContain("height: 1vw;");
    expect(loadingCss).toContain("bottom: 14%;");
    expect(loadingCss).toContain("background: #000;");
    expect(loadingCss).toContain("#3192d8 0, #0061a7 5vw, #0061a7 100%");
    expect(loadingCss).toContain("box-shadow: inset 0 0 0 2px #000;");
    expect(loadingCss).toContain(
      "transition: transform 500ms cubic-bezier(0.245, 0.435, 0.875, 0.66);",
    );
  });

  it("carries the official phone and tablet portrait/landscape breakpoints", () => {
    expect(loadingCss).toMatch(/@media \(orientation: portrait\)[\s\S]*?width: 45%;[\s\S]*?height: 2vw;/);
    expect(loadingCss).toMatch(/@media \(orientation: landscape\)[\s\S]*?width: 10vw;[\s\S]*?height: 3vw;/);
    expect(loadingCss).toMatch(/@media \(min-width: 768px\)[\s\S]*?bottom: 15%;[\s\S]*?height: 0\.7em;/);
    expect(loadingCss).toContain("width: 30vw;");
    expect(loadingCss).toContain("height: calc(30vw * 0.4);");
    expect(loadingCss).toContain("width: calc(6.5vh * 3);");
    expect(loadingCss).toContain("height: 6.5vh;");
  });

  it("keeps progress accessible without drawing invented status or percentage text", () => {
    expect(indexHtml).toContain('role="status"');
    expect(indexHtml).toContain('aria-live="polite"');
    expect(loadingCss).toMatch(
      /\.launch-loading__brand,[\s\S]*?\.launch-loading__value\s*\{[\s\S]*?clip-path: inset\(50%\);/,
    );
  });
});
