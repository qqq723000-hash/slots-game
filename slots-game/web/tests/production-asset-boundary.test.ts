// @ts-nocheck -- 该契约测试只在 Node/Vitest 中读取构建脚本。 / English: @ts-nocheck -- This contract test only reads the build script in Node/Vitest.
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoForbiddenProductionSentinels,
  reachableProductionAssets,
} from "../scripts/production-asset-graph.mjs";
import { regularFilesUnder } from "../scripts/production-file-tree.mjs";

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
    expect(source).toContain("public tree contains forbidden evidence or credential files");
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
    expect(source).toContain("reachableProductionAssets");
    expect(source).toContain("assertNoForbiddenProductionSentinels");
    expect(source).toContain("regularFilesUnder");
    expect(source).toContain('!sourceName.startsWith("src/testing/")');
    expect(source).not.toContain('name.startsWith("assets/brand/")');
  });

  it("只保留从生产首页可达的模块图并排除孤立分块", () => {
    const reachable = reachableProductionAssets(
      '<script type="module" src="/assets/entry.js"></script><link rel="stylesheet" href="/assets/app.css">',
      [
        { name: "assets/entry.js", source: 'import "./shared.js"; import("./app.js");' },
        { name: "assets/shared.js", source: "export const shared = true;" },
        { name: "assets/app.js", source: "export const app = true;" },
        { name: "assets/app.css", source: "body { color: white; }" },
        { name: "assets/orphan.js", source: "export const fixture = true;" },
      ],
    );

    expect([...reachable].sort()).toEqual([
      "assets/app.css",
      "assets/app.js",
      "assets/entry.js",
      "assets/shared.js",
    ]);
    expect(reachable.has("assets/orphan.js")).toBe(false);
  });

  it("任何正式分块出现表现夹具标记都必须拒绝", () => {
    expect(() => assertNoForbiddenProductionSentinels([
      {
        name: "assets/orphan-fixture.js",
        source: 'document.body.dataset.fixtureEvidenceScope="presentation-only-no-rgs-settlement";',
      },
    ])).toThrow(/正式发布资源含表现夹具标记/u);
  });

  it("发布遍历必须拒绝清单无法哈希的符号链接节点", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "slots-production-tree-"));
    try {
      await writeFile(resolve(root, "regular.js"), "export const regular = true;\n");
      await symlink("regular.js", resolve(root, "unmanifested.js"), "file");
      await expect(regularFilesUnder(root)).rejects.toThrow(
        /生产发布树含非普通节点 symbolic-link：unmanifested\.js/u,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("第三方许可声明必须保留在发布白名单并进入可复算发布清单", () => {
    const source = readFileSync(
      new URL("../scripts/finalize-production-assets.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain('"THIRD_PARTY_NOTICES.txt",');
    expect(source).toContain('"browser-preflight.js",');
  });
});
