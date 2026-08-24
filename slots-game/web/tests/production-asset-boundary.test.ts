// @ts-nocheck -- 该契约测试只在 Node/Vitest 中读取构建脚本。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("生产资产边界", () => {
  it("构建流程必须在 Vite 后生成并校验发布白名单", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.prebuild).toContain("assets:provenance-check");
    expect(pkg.scripts.pretest).toContain("assets:provenance-check");
    expect(pkg.scripts.build).toContain("finalize-production-assets.mjs");
    expect(pkg.scripts["build:assets-check"]).toContain("--check");
  });

  it("公开目录必须由机器可读权属清单完整分类", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const inventory = JSON.parse(
      readFileSync(new URL("../asset-provenance.json", import.meta.url), "utf8"),
    );
    const source = readFileSync(
      new URL("../scripts/verify-asset-provenance.mjs", import.meta.url),
      "utf8",
    );

    expect(pkg.scripts["assets:provenance-check"]).toContain("verify-asset-provenance.mjs");
    expect(inventory.policy).toBe("DENY_COMMERCIAL_RELEASE_WITHOUT_EXTERNAL_EXACT_HASH_APPROVAL");
    expect(source).toContain("isProtectedReleaseAsset");
    expect(source).toContain("public tree contains documentation or evidence files");
  });

  it("发布脚本必须排除源码映射、说明文件与证据目录", () => {
    const source = readFileSync(
      new URL("../scripts/finalize-production-assets.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain('name.endsWith(".map")');
    expect(source).toContain("release-manifest.json");
    expect(source).toContain("assets/primal-runtime/");
    expect(source).toContain('"assets/primal-reference"');
  });

  it("第三方许可声明必须保留在发布白名单并进入可复算发布清单", () => {
    const source = readFileSync(
      new URL("../scripts/finalize-production-assets.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain('new Set(["index.html", "favicon.ico", "THIRD_PARTY_NOTICES.txt"])');
  });
});
