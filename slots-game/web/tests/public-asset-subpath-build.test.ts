// @ts-nocheck -- 在隔离临时目录运行真实 Vite 构建并检查最终 HTML/CSS 字节。
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  isPublicAssetPathname,
  publicAssetPathPrefix,
  publicAssetUrl,
} from "../src/assets/publicAssetUrl";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("public asset subpath build", () => {
  it("normalizes helper URLs and security prefixes under the configured base", () => {
    expect(publicAssetUrl("/assets/wheel.bin", "/casino/primal/")).toBe(
      "/casino/primal/assets/wheel.bin",
    );
    expect(publicAssetPathPrefix("/casino/primal/")).toBe("/casino/primal/assets/");
    expect(isPublicAssetPathname(
      "/casino/primal/assets/primal-runtime/wheel.bin",
      "/casino/primal/",
    )).toBe(true);
    expect(isPublicAssetPathname(
      "/assets/primal-runtime/wheel.bin",
      "/casino/primal/",
    )).toBe(false);
  });

  it("rebases the favicon, entry chunks, fonts, and feature CSS in real Vite output", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "slots-subpath-build-"));
    try {
      execFileSync(
        resolve(webRoot, "node_modules/.bin/vite"),
        ["build", "--base=/casino/primal/", "--outDir", outputDirectory, "--emptyOutDir"],
        { cwd: webRoot, stdio: "ignore" },
      );

      const html = readFileSync(join(outputDirectory, "index.html"), "utf8");
      expect(html).toContain('href="/casino/primal/favicon.ico"');
      expect(html).toMatch(/src="\/casino\/primal\/assets\/[^"/]+\.js"/);
      expect(html).toMatch(/href="\/casino\/primal\/assets\/[^"/]+\.css"/);

      const cssName = readdirSync(join(outputDirectory, "assets"))
        .find((name) => name.endsWith(".css"));
      expect(cssName).toBeTruthy();
      const css = readFileSync(join(outputDirectory, "assets", cssName), "utf8");
      expect(css).toContain("/casino/primal/assets/primal-runtime/fonts/KANIT_BOLD.woff");
      expect(css).toContain(
        "/casino/primal/assets/primal-runtime/interface/fps_ui_texture0_level1.avif",
      );
      expect(css).not.toMatch(/url\((?:["'])?\/assets\//);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
