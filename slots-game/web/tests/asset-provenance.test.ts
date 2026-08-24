// @ts-nocheck -- Node 夹具用于验证仓库资源门禁的失败关闭行为。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyAssetProvenance } from "../scripts/verify-asset-provenance.mjs";

const temporaryDirectories: string[] = [];

function inventory(groups = [
  ["favicon.ico", "exact", "UNVERIFIED_IN_REPOSITORY"],
  ["assets/brand/", "prefix", "OWNER_ASSERTED_FIRST_PARTY"],
  ["assets/primal-reference/", "prefix", "UNVERIFIED_IN_REPOSITORY"],
  ["assets/primal-runtime/", "prefix", "UNVERIFIED_IN_REPOSITORY"],
]) {
  return {
    schemaVersion: 1,
    policy: "DENY_COMMERCIAL_RELEASE_WITHOUT_EXTERNAL_EXACT_HASH_APPROVAL",
    groups: groups.map(([selector, match, repositoryEvidence]) => ({
      selector,
      match,
      repositoryEvidence,
      releaseDisposition: "EXTERNAL_APPROVAL_REQUIRED",
    })),
  };
}

function fixture(options: { extraPath?: string; groups?: string[][] } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "slots-asset-provenance-"));
  temporaryDirectories.push(directory);
  const publicDirectory = resolve(directory, "public");
  mkdirSync(resolve(publicDirectory, "assets/brand"), { recursive: true });
  writeFileSync(resolve(publicDirectory, "assets/brand/logo.png"), "brand");
  writeFileSync(resolve(publicDirectory, "favicon.ico"), "icon");
  writeFileSync(resolve(publicDirectory, "THIRD_PARTY_NOTICES.txt"), "notices");
  if (options.extraPath) {
    const path = resolve(publicDirectory, options.extraPath);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "extra");
  }
  const inventoryPath = resolve(directory, "asset-provenance.json");
  writeFileSync(inventoryPath, `${JSON.stringify(inventory(options.groups))}\n`);
  return { publicDirectory, inventoryPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("asset provenance gate", () => {
  it("accepts a completely classified public tree", async () => {
    await expect(verifyAssetProvenance(fixture())).resolves.toEqual({
      protectedCount: 2,
      publicFileCount: 3,
    });
  });

  it("rejects documentation copied into the public tree", async () => {
    await expect(verifyAssetProvenance(fixture({ extraPath: "assets/README.md" })))
      .rejects.toThrow("public tree contains documentation or evidence files");
  });

  it("rejects a public file outside the protected selectors and explicit notice allow-list", async () => {
    await expect(verifyAssetProvenance(fixture({ extraPath: "debug.json" })))
      .rejects.toThrow("public files are outside the release policy");
  });

  it("rejects an inventory that omits a protected selector", async () => {
    const groups = [
      ["favicon.ico", "exact", "UNVERIFIED_IN_REPOSITORY"],
      ["assets/brand/", "prefix", "OWNER_ASSERTED_FIRST_PARTY"],
      ["assets/primal-reference/", "prefix", "UNVERIFIED_IN_REPOSITORY"],
    ];
    await expect(verifyAssetProvenance(fixture({ groups })))
      .rejects.toThrow("missing protected selector: assets/primal-runtime/");
  });
});
