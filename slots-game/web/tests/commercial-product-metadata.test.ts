// @ts-nocheck -- 仅在 Node/Vitest 中读取发布元数据与确定性生成制品。 / English: @ts-nocheck -- Only read release metadata and deterministically build artifacts in Node/Vitest.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function text(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("commercial Web product metadata", () => {
  it("keeps the private package and lockfile on the shipped Primal Rampage identity", () => {
    const releaseVersion = text("../../VERSION").trim();
    const packageJson = JSON.parse(text("../package.json")) as Record<string, unknown>;
    const packageLock = JSON.parse(text("../package-lock.json")) as {
      name?: unknown;
      version?: unknown;
      packages?: Record<string, Record<string, unknown>>;
    };

    expect(packageJson).toMatchObject({
      name: "primal-rampage-web",
      version: releaseVersion,
      description: "Primal Rampage production browser client.",
      private: true,
      license: "UNLICENSED",
    });
    expect(packageLock.name).toBe(packageJson.name);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages?.[""]).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
      license: packageJson.license,
    });
  });

  it("uses the same product identity in operator-facing documentation and generated notices", () => {
    const readme = text("../README.md");
    const generator = text("../scripts/generate-third-party-notices.mjs");
    const notice = text("../public/THIRD_PARTY_NOTICES.txt");

    expect(readme).toMatch(/^# Primal Rampage 前端$/m);
    expect(readme).not.toContain("# Iron Colossus 前端");
    expect(generator).toContain('"PRIMAL RAMPAGE WEB 第三方许可声明"');
    expect(notice.startsWith("PRIMAL RAMPAGE WEB 第三方许可声明\n")).toBe(true);
  });
});
