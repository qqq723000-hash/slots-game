import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";

import { createReleaseManifest } from "../../web/scripts/release-manifest.mjs";
import { verifyReleaseAssetApproval } from "../../web/scripts/verify-release-asset-approval.mjs";
import {
  commitLocalAssetApprovalCandidate,
  LocalAssetApprovalRotationError,
  prepareLocalAssetApprovalCandidate,
  rotateLocalAssetApproval,
} from "./rotate-asset-approval.mjs";

const temporaryRoots = [];
const digest = (character) => character.repeat(64);

function makeFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "slots-local-asset-rotation-"));
  temporaryRoots.push(root);
  const secrets = resolve(root, "secrets");
  const backups = resolve(root, "backups");
  mkdirSync(secrets, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  chmodSync(secrets, 0o700);
  chmodSync(backups, 0o700);
  return {
    root,
    secrets,
    backups,
    manifestPath: resolve(root, "release-manifest.json"),
    approvalPath: resolve(secrets, "release-asset-approval.json"),
    pendingPath: resolve(root, "release-asset-approval.pending.json"),
  };
}

function files(featureHash = digest("b")) {
  return [
    { path: "assets/brand/statusbar.png", bytes: 31, sha256: digest("a") },
    { path: "assets/primal-runtime/feature.bin", bytes: 42, sha256: featureHash },
    { path: "favicon.ico", bytes: 53, sha256: digest("c") },
    { path: "assets/app.js", bytes: 64, sha256: digest("d") },
  ];
}

function writeManifest(fixture, version, manifestFiles = files()) {
  const manifest = createReleaseManifest({
    version,
    revision: "e".repeat(40),
    files: manifestFiles,
    requireRevision: true,
  });
  writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function rotate(fixture, now) {
  return rotateLocalAssetApproval({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    backupRoot: fixture.backups,
    now,
  });
}

function mode(path) {
  return lstatSync(path).mode & 0o777;
}

function expectedVerification(path) {
  const approval = JSON.parse(readFileSync(path, "utf8"));
  return { approvedAssets: 3, expiresAt: approval.expiresAt };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates a missing local approval atomically without a backup", () => {
  const fixture = makeFixture();
  const now = new Date("2026-08-26T01:00:00.000Z");
  writeManifest(fixture, "asset-create-1");

  assert.deepEqual(rotate(fixture, now), { action: "created", approvedAssets: 3 });
  assert.equal(mode(fixture.approvalPath), 0o600);
  assert.deepEqual(readdirSync(fixture.backups), []);
  assert.deepEqual(verifyReleaseAssetApproval({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    now,
  }), expectedVerification(fixture.approvalPath));
});

test("leaves an exact unexpired approval byte-for-byte unchanged", () => {
  const fixture = makeFixture();
  writeManifest(fixture, "asset-stable-1");
  rotate(fixture, new Date("2026-08-26T02:00:00.000Z"));
  const before = readFileSync(fixture.approvalPath, "utf8");

  assert.deepEqual(rotate(fixture, new Date("2026-08-27T02:00:00.000Z")), {
    action: "unchanged",
    approvedAssets: 3,
  });
  assert.equal(readFileSync(fixture.approvalPath, "utf8"), before);
  assert.deepEqual(readdirSync(fixture.backups), []);
});

test("backs up and rotates an exact manifest mismatch while preserving unrelated secrets", () => {
  const fixture = makeFixture();
  const firstNow = new Date("2026-08-26T03:00:00.000Z");
  writeManifest(fixture, "asset-old-1");
  rotate(fixture, firstNow);
  const oldApproval = readFileSync(fixture.approvalPath, "utf8");
  const unrelatedPath = resolve(fixture.secrets, "unrelated.token");
  writeFileSync(unrelatedPath, "preserve-me\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(unrelatedPath, 0o600);

  const changedFiles = files(digest("f"));
  changedFiles[1] = { ...changedFiles[1], bytes: 43 };
  writeManifest(fixture, "asset-new-1", changedFiles);
  const result = rotate(fixture, new Date("2026-08-26T04:00:00.000Z"));

  assert.equal(result.action, "rotated-manifest");
  assert.equal(result.approvedAssets, 3);
  assert.equal(readFileSync(unrelatedPath, "utf8"), "preserve-me\n");
  assert.equal(mode(unrelatedPath), 0o600);
  const backupDirectories = readdirSync(fixture.backups, { withFileTypes: true });
  assert.equal(backupDirectories.length, 1);
  assert.equal(backupDirectories[0].isDirectory(), true);
  const backupDirectory = resolve(fixture.backups, backupDirectories[0].name);
  assert.equal(mode(backupDirectory), 0o700);
  assert.deepEqual(readdirSync(backupDirectory), ["release-asset-approval.json"]);
  const backupPath = resolve(backupDirectory, "release-asset-approval.json");
  assert.equal(mode(backupPath), 0o600);
  assert.equal(readFileSync(backupPath, "utf8"), oldApproval);
  assert.deepEqual(verifyReleaseAssetApproval({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    now: new Date("2026-08-26T04:00:00.000Z"),
  }), expectedVerification(fixture.approvalPath));

  assert.equal(rotate(fixture, new Date("2026-08-26T05:00:00.000Z")).action, "unchanged");
  assert.equal(readdirSync(fixture.backups).length, 1);
});

test("prepares a changed approval without polluting the committed approval when definition commit fails", () => {
  const fixture = makeFixture();
  writeManifest(fixture, "asset-transaction-old");
  rotate(fixture, new Date("2026-08-26T04:00:00.000Z"));
  const committedBefore = readFileSync(fixture.approvalPath, "utf8");
  writeManifest(fixture, "asset-transaction-new", files(digest("f")));

  const prepared = prepareLocalAssetApprovalCandidate({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    pendingPath: fixture.pendingPath,
    now: new Date("2026-08-26T05:00:00.000Z"),
  });

  assert.equal(prepared.action, "rotated-manifest");
  assert.equal(readFileSync(fixture.approvalPath, "utf8"), committedBefore);
  assert.equal(mode(fixture.pendingPath), 0o600);
  assert.deepEqual(verifyReleaseAssetApproval({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.pendingPath,
    now: new Date("2026-08-26T05:00:00.000Z"),
  }), expectedVerification(fixture.pendingPath));
  // 模拟随后定义提交失败：不调用 commit，已提交审批和备份必须保持不变。
  assert.equal(readFileSync(fixture.approvalPath, "utf8"), committedBefore);
  assert.deepEqual(readdirSync(fixture.backups), []);
});

test("commits only the exact prepared approval and retains a recoverable backup", () => {
  const fixture = makeFixture();
  writeManifest(fixture, "asset-commit-old");
  rotate(fixture, new Date("2026-08-26T06:00:00.000Z"));
  const committedBefore = readFileSync(fixture.approvalPath, "utf8");
  writeManifest(fixture, "asset-commit-new", files(digest("f")));
  const now = new Date("2026-08-26T07:00:00.000Z");
  const prepared = prepareLocalAssetApprovalCandidate({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    pendingPath: fixture.pendingPath,
    now,
  });

  const committed = commitLocalAssetApprovalCandidate({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    backupRoot: fixture.backups,
    pendingPath: fixture.pendingPath,
    expectedApprovalSha256: prepared.expectedApprovalSha256,
    candidateApprovalSha256: prepared.candidateApprovalSha256,
    now,
  });

  assert.deepEqual(committed, { action: "rotated-manifest", approvedAssets: 3 });
  assert.equal(existsSync(fixture.pendingPath), false);
  assert.deepEqual(verifyReleaseAssetApproval({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    now,
  }), expectedVerification(fixture.approvalPath));
  const [backupName] = readdirSync(fixture.backups);
  assert.equal(
    readFileSync(resolve(fixture.backups, backupName, "release-asset-approval.json"), "utf8"),
    committedBefore,
  );
});

test("backs up and renews an otherwise exact expired local approval", () => {
  const fixture = makeFixture();
  writeManifest(fixture, "asset-expired-1");
  rotate(fixture, new Date("2025-01-01T00:00:00.000Z"));
  const oldApproval = readFileSync(fixture.approvalPath, "utf8");

  const result = rotate(fixture, new Date("2026-01-02T00:00:00.000Z"));
  assert.equal(result.action, "rotated-expired");
  const updated = JSON.parse(readFileSync(fixture.approvalPath, "utf8"));
  assert.equal(updated.expiresAt, "2027-01-02T00:00:00.000Z");
  const [backupName] = readdirSync(fixture.backups);
  assert.equal(
    readFileSync(resolve(fixture.backups, backupName, "release-asset-approval.json"), "utf8"),
    oldApproval,
  );
});

test("fails closed on unsupported approval fields even when the manifest changed", () => {
  const fixture = makeFixture();
  writeManifest(fixture, "asset-unknown-old");
  rotate(fixture, new Date("2026-08-26T06:00:00.000Z"));
  const malformed = JSON.parse(readFileSync(fixture.approvalPath, "utf8"));
  malformed.untrustedOverride = true;
  const malformedRaw = `${JSON.stringify(malformed, null, 2)}\n`;
  writeFileSync(fixture.approvalPath, malformedRaw, "utf8");
  writeManifest(fixture, "asset-unknown-new", files(digest("f")));

  assert.throws(
    () => rotate(fixture, new Date("2026-08-26T07:00:00.000Z")),
    (error) => error instanceof LocalAssetApprovalRotationError
      && /unsupported fields/u.test(error.message),
  );
  assert.equal(readFileSync(fixture.approvalPath, "utf8"), malformedRaw);
  assert.deepEqual(readdirSync(fixture.backups), []);
});

test("fails closed on invalid JSON, non-local authority, and permissive file modes", async (t) => {
  await t.test("invalid JSON", () => {
    const fixture = makeFixture();
    writeManifest(fixture, "asset-invalid-json");
    writeFileSync(fixture.approvalPath, "{invalid\n", { encoding: "utf8", mode: 0o600 });
    chmodSync(fixture.approvalPath, 0o600);
    assert.throws(() => rotate(fixture, new Date("2026-08-26T08:00:00.000Z")), /not valid JSON/u);
    assert.equal(readFileSync(fixture.approvalPath, "utf8"), "{invalid\n");
    assert.deepEqual(readdirSync(fixture.backups), []);
  });

  await t.test("non-local authority", () => {
    const fixture = makeFixture();
    writeManifest(fixture, "asset-external-authority");
    rotate(fixture, new Date("2026-08-26T09:00:00.000Z"));
    const approval = JSON.parse(readFileSync(fixture.approvalPath, "utf8"));
    approval.approvalReference = "external-operator-approval";
    const raw = `${JSON.stringify(approval, null, 2)}\n`;
    writeFileSync(fixture.approvalPath, raw, "utf8");
    assert.throws(() => rotate(fixture, new Date("2026-08-26T10:00:00.000Z")), /not owned/u);
    assert.equal(readFileSync(fixture.approvalPath, "utf8"), raw);
    assert.deepEqual(readdirSync(fixture.backups), []);
  });

  await t.test("permissive mode", () => {
    const fixture = makeFixture();
    writeManifest(fixture, "asset-permissive-mode");
    rotate(fixture, new Date("2026-08-26T11:00:00.000Z"));
    chmodSync(fixture.approvalPath, 0o644);
    assert.throws(() => rotate(fixture, new Date("2026-08-26T12:00:00.000Z")), /0600/u);
    assert.equal(mode(fixture.approvalPath), 0o644);
    assert.deepEqual(readdirSync(fixture.backups), []);
  });
});
