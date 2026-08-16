// @ts-nocheck -- 发布门控会刻意在 Node 中校验不透明的 JSON 夹具。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ReleaseAssetApprovalError,
  verifyReleaseAssetApproval,
} from "../scripts/verify-release-asset-approval.mjs";
import { createReleaseManifest } from "../scripts/release-manifest.mjs";

const hash = (character: string) => character.repeat(64);

const protectedFiles = [
  { path: "assets/primal-runtime/audio/ambient.m4a", bytes: 101, sha256: hash("a") },
  { path: "assets/primal-reference/character.svg", bytes: 202, sha256: hash("b") },
  { path: "assets/brand/statusbar.png", bytes: 303, sha256: hash("c") },
];

const temporaryDirectories: string[] = [];

function makeFixture(options: {
  approval?: Record<string, unknown>;
  manifestFiles?: Array<Record<string, unknown>>;
} = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), "slots-release-asset-approval-"));
  temporaryDirectories.push(directory);
  const manifestPath = resolve(directory, "release-manifest.json");
  const approvalPath = resolve(directory, "approval.json");
  const manifestFiles = options.manifestFiles ?? [
    ...protectedFiles,
    { path: "assets/app-DEMO1234.js", bytes: 404, sha256: hash("d") },
  ];
  const approval = options.approval ?? {
    schemaVersion: 1,
    status: "APPROVED",
    approvalReference: "test-only-approval-reference",
    jurisdictions: ["TEST-ONLY"],
    expiresAt: "2035-01-01T00:00:00.000Z",
    assets: protectedFiles,
  };

  const manifest = createReleaseManifest({
    version: "1.2.3-test",
    revision: hash("a").slice(0, 40),
    files: manifestFiles,
    requireRevision: true,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  writeFileSync(approvalPath, `${JSON.stringify(approval)}\n`);
  return { manifestPath, approvalPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("release asset approval gate", () => {
  it("accepts an unexpired, exact approval for every protected release asset", () => {
    const fixture = makeFixture();

    expect(verifyReleaseAssetApproval(fixture)).toEqual({ approvedAssets: 3 });
  });

  it("fails closed when RELEASE_ASSET_APPROVAL_FILE is absent", () => {
    const fixture = makeFixture();

    expect(() => verifyReleaseAssetApproval({ manifestPath: fixture.manifestPath, approvalPath: "" }))
      .toThrow(ReleaseAssetApprovalError);
    expect(() => verifyReleaseAssetApproval({ manifestPath: fixture.manifestPath, approvalPath: "" }))
      .toThrow("RELEASE_ASSET_APPROVAL_FILE is required");
  });

  it("rejects an expired approval", () => {
    const fixture = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: "test-only-approval-reference",
        jurisdictions: ["TEST-ONLY"],
        expiresAt: "2020-01-01T00:00:00.000Z",
        assets: protectedFiles,
      },
    });

    expect(() => verifyReleaseAssetApproval(fixture)).toThrow("approval has expired");
  });

  it("rejects an approval whose status is not APPROVED", () => {
    const fixture = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "PENDING",
        approvalReference: "test-only-approval-reference",
        jurisdictions: ["TEST-ONLY"],
        expiresAt: "2035-01-01T00:00:00.000Z",
        assets: protectedFiles,
      },
    });

    expect(() => verifyReleaseAssetApproval(fixture)).toThrow("approval.status must be APPROVED");
  });

  it("rejects an approval missing its reference or jurisdictions", () => {
    const missingReference = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: "",
        jurisdictions: ["TEST-ONLY"],
        expiresAt: "2035-01-01T00:00:00.000Z",
        assets: protectedFiles,
      },
    });
    const missingJurisdictions = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: "test-only-approval-reference",
        jurisdictions: [],
        expiresAt: "2035-01-01T00:00:00.000Z",
        assets: protectedFiles,
      },
    });

    expect(() => verifyReleaseAssetApproval(missingReference)).toThrow("approval.approvalReference");
    expect(() => verifyReleaseAssetApproval(missingJurisdictions)).toThrow("approval.jurisdictions");
  });

  it("rejects an approval whose asset hash differs from the release manifest", () => {
    const fixture = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: "test-only-approval-reference",
        jurisdictions: ["TEST-ONLY"],
        expiresAt: "2035-01-01T00:00:00.000Z",
        assets: [
          { ...protectedFiles[0], sha256: hash("f") },
          ...protectedFiles.slice(1),
        ],
      },
    });

    expect(() => verifyReleaseAssetApproval(fixture)).toThrow("approval hash does not match release manifest");
  });

  it("rejects an approval that omits a protected release asset", () => {
    const fixture = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: "test-only-approval-reference",
        jurisdictions: ["TEST-ONLY"],
        expiresAt: "2035-01-01T00:00:00.000Z",
        assets: protectedFiles.slice(0, 2),
      },
    });

    expect(() => verifyReleaseAssetApproval(fixture)).toThrow("approval does not cover protected release asset");
  });
});
