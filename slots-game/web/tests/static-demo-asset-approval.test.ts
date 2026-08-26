// @ts-nocheck -- Node 测试夹具用于验证外部审批包装器。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReleaseManifest } from "../scripts/release-manifest.mjs";
import { verifyStaticDemoAssetApproval } from "../scripts/verify-static-demo-asset-approval.mjs";

const temporaryDirectories: string[] = [];
const digest = (character: string) => character.repeat(64);

function fixture({
  approvedDigest = digest("a"),
  jurisdictions = ["PUBLIC-INTERNET"],
} = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "static-demo-approval-"));
  temporaryDirectories.push(directory);
  const manifestPath = resolve(directory, "release-manifest.json");
  const approvalPath = resolve(directory, "approval.json");
  const protectedAsset = {
    path: "assets/primal-reference/public-demo.png",
    bytes: 123,
    sha256: digest("a"),
  };
  const manifest = createReleaseManifest({
    version: "1.2.0-test",
    revision: digest("b").slice(0, 40),
    files: [
      protectedAsset,
      { path: "index.html", bytes: 456, sha256: digest("c") },
    ],
    requireRevision: true,
  });
  const approval = {
    schemaVersion: 1,
    status: "APPROVED",
    approvalReference: "external-static-demo-test-approval",
    jurisdictions,
    expiresAt: "2035-01-01T00:00:00Z",
    assets: [{ ...protectedAsset, sha256: approvedDigest }],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`);
  return { manifestPath, approvalPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("static demo external asset approval", () => {
  it("accepts the same canonical exact-hash approval used by formal Web releases", () => {
    expect(verifyStaticDemoAssetApproval(fixture())).toEqual({
      approvedAssets: 1,
      expiresAt: "2035-01-01T00:00:00Z",
    });
  });

  it("fails closed without approval and rejects a digest mismatch", () => {
    const valid = fixture();
    expect(() => verifyStaticDemoAssetApproval({
      manifestPath: valid.manifestPath,
      approvalPath: "",
    })).toThrow("RELEASE_ASSET_APPROVAL_FILE is required");

    expect(() => verifyStaticDemoAssetApproval(fixture({ approvedDigest: digest("d") })))
      .toThrow("approval hash does not match release manifest");
  });

  it("rejects an approval limited to a non-public jurisdiction", () => {
    expect(() => verifyStaticDemoAssetApproval(fixture({ jurisdictions: ["GB"] })))
      .toThrow("approval.jurisdictions must explicitly include PUBLIC-INTERNET");
  });
});
