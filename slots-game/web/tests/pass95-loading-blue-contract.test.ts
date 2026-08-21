// @ts-nocheck -- 仅在 Node 中运行的静态 CSS/HTML 证据契约测试。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))]
    .map((match) => match[1] ?? "");
}

function lastRuleBody(selector: string): string {
  const bodies = ruleBodies(selector);
  const body = bodies.at(-1);
  if (body === undefined) throw new Error(`Missing CSS rule: ${selector}`);
  return body;
}

describe("Pass 95 official PC loading-blue contract", () => {
  it("releases the transparent fallback barrier while preserving the visible startup gate", () => {
    expect(ruleBodies(".launch-loading")).toContainEqual(
      expect.stringContaining("pointer-events: none;"),
    );
    expect(lastRuleBody('.launch-loading[data-visible="true"]')).toContain(
      "pointer-events: auto;",
    );
  });

  it("uses the frozen ContainerLauncher radial gradient as the final loader background", () => {
    const loader = lastRuleBody(".launch-loading");
    const declaration = loader.match(/background\s*:\s*([^;]+);/)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();

    expect(declaration).toBe("radial-gradient(#002448, #000e20)");
    expect(declaration).not.toMatch(/rgba\(|linear-gradient|#19140f|#060605/i);
  });

  it("locks the browser chrome and startup fallback surfaces to the outer blue", () => {
    expect(indexHtml).toMatch(
      /<meta\s+name=["']theme-color["']\s+content=["']#000e20["']\s*\/>/i,
    );
    expect(lastRuleBody("html,\nbody,\n#app")).toContain("background: #000e20;");
    expect(lastRuleBody("body")).toContain("background: #000e20;");
    expect(lastRuleBody(".viewport")).toContain("background: #000e20;");
    expect(lastRuleBody(".game-frame")).toContain("background: #15100c;");
  });

  it("removes only the invented warm separator lines from the final loader skin", () => {
    const separators = lastRuleBody(
      ".launch-loading::before,\n.launch-loading::after",
    );

    expect(separators).toMatch(/content\s*:\s*none\s*;/);
  });
});
