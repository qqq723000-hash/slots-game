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
  { path: "favicon.ico", bytes: 304, sha256: hash("e") },
];

const temporaryDirectories: string[] = [];

function makeFixture(options: {
  approval?: Record<string, unknown>;
  approvalRaw?: string;
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
  writeFileSync(approvalPath, options.approvalRaw ?? `${JSON.stringify(approval, null, 2)}\n`);
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

    expect(verifyReleaseAssetApproval(fixture)).toEqual({ approvedAssets: 4 });
  });

  it("rejects unsupported approval and asset fields", () => {
    const unsupportedApproval = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: "test-only-approval-reference",
        jurisdictions: ["TEST-ONLY"],
        expiresAt: "2035-01-01T00:00:00.000Z",
        assets: protectedFiles,
        operatorNote: "must not be ignored",
      },
    });
    const unsupportedAsset = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: "test-only-approval-reference",
        jurisdictions: ["TEST-ONLY"],
        expiresAt: "2035-01-01T00:00:00.000Z",
        assets: [
          { ...protectedFiles[0], source: "must not be ignored" },
          ...protectedFiles.slice(1),
        ],
      },
    });

    expect(() => verifyReleaseAssetApproval(unsupportedApproval))
      .toThrow("release asset approval contains unsupported fields");
    expect(() => verifyReleaseAssetApproval(unsupportedAsset))
      .toThrow("approval.assets[0] contains unsupported fields");
  });

  it("rejects duplicate JSON keys at approval and asset scope", () => {
    const canonical = {
      schemaVersion: 1,
      status: "APPROVED",
      approvalReference: "test-only-approval-reference",
      jurisdictions: ["TEST-ONLY"],
      expiresAt: "2035-01-01T00:00:00.000Z",
      assets: protectedFiles,
    };
    const duplicateApprovalKey = makeFixture({
      approvalRaw: `${JSON.stringify(canonical, null, 2).replace(
        '  "status": "APPROVED",',
        '  "status": "APPROVED",\n  "status": "APPROVED",',
      )}\n`,
    });
    const duplicateAssetKey = makeFixture({
      approvalRaw: `${JSON.stringify(canonical, null, 2).replace(
        '      "bytes": 101,',
        '      "bytes": 101,\n      "bytes": 101,',
      )}\n`,
    });

    expect(() => verifyReleaseAssetApproval(duplicateApprovalKey))
      .toThrow("release asset approval is not canonical JSON");
    expect(() => verifyReleaseAssetApproval(duplicateAssetKey))
      .toThrow("release asset approval is not canonical JSON");
  });

  it("rejects valid but non-canonical JSON encodings", () => {
    const approval = {
      schemaVersion: 1,
      status: "APPROVED",
      approvalReference: "test-only-approval-reference",
      jurisdictions: ["TEST-ONLY"],
      expiresAt: "2035-01-01T00:00:00.000Z",
      assets: protectedFiles,
    };
    const compact = makeFixture({ approvalRaw: `${JSON.stringify(approval)}\n` });
    const reordered = makeFixture({
      approvalRaw: `${JSON.stringify({ status: approval.status, ...approval }, null, 2)}\n`,
    });
    const trailingWhitespace = makeFixture({
      approvalRaw: `${JSON.stringify(approval, null, 2)}\n\n`,
    });

    expect(() => verifyReleaseAssetApproval(compact))
      .toThrow("release asset approval is not canonical JSON");
    expect(() => verifyReleaseAssetApproval(reordered))
      .toThrow("release asset approval is not canonical JSON");
    expect(() => verifyReleaseAssetApproval(trailingWhitespace))
      .toThrow("release asset approval is not canonical JSON");
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

  it("requires an exact approval for the public favicon", () => {
    const fixture = makeFixture({
      approval: {
        schemaVersion: 1,
        status: "APPROVED",
        approvalReference: "test-only-approval-reference",
        jurisdictions: ["TEST-ONLY"],
        expiresAt: "2035-01-01T00:00:00.000Z",
        assets: protectedFiles.slice(0, 3),
      },
    });

    expect(() => verifyReleaseAssetApproval(fixture)).toThrow("approval does not cover protected release asset");
  });
});
