import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";

import {
  createReleaseManifest,
  UNAVAILABLE_RELEASE_REVISION,
} from "../../web/scripts/release-manifest.mjs";
import { verifyReleaseAssetApproval } from "../../web/scripts/verify-release-asset-approval.mjs";
import {
  commitLocalAssetApprovalCandidate,
  LocalAssetApprovalRotationError,
  prepareLocalAssetApprovalCandidate,
  rotateLocalAssetApproval,
} from "./rotate-asset-approval.mjs";

const temporaryRoots = [];
const digest = (character) => character.repeat(64);
const rotationScript = fileURLToPath(new URL("./rotate-asset-approval.mjs", import.meta.url));

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

function writeManifest(
  fixture,
  version,
  manifestFiles = files(),
  revision = "e".repeat(40),
) {
  const manifest = createReleaseManifest({
    version,
    revision,
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

test("rejects an anonymous legacy manifest through every rotation entry point", async (t) => {
  const anonymousManifest = createReleaseManifest({
    version: "asset-unidentified-1",
    revision: UNAVAILABLE_RELEASE_REVISION,
    files: files(),
  });
  const anonymousRaw = `${JSON.stringify(anonymousManifest, null, 2)}\n`;

  await t.test("direct rotation", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.manifestPath, anonymousRaw, "utf8");
    assert.throws(
      () => rotate(fixture, new Date("2026-08-26T01:30:00.000Z")),
      /release revision must be a complete lowercase Git commit digest/u,
    );
    assert.equal(existsSync(fixture.approvalPath), false);
    assert.deepEqual(readdirSync(fixture.backups), []);
  });

  await t.test("prepare", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.manifestPath, anonymousRaw, "utf8");
    assert.throws(() => prepareLocalAssetApprovalCandidate({
      manifestPath: fixture.manifestPath,
      approvalPath: fixture.approvalPath,
      pendingPath: fixture.pendingPath,
      now: new Date("2026-08-26T01:30:00.000Z"),
    }), /release revision must be a complete lowercase Git commit digest/u);
    assert.equal(existsSync(fixture.pendingPath), false);
    assert.equal(existsSync(fixture.approvalPath), false);
  });

  await t.test("commit", () => {
    const fixture = makeFixture();
    writeManifest(fixture, "asset-identified-1");
    const prepared = prepareLocalAssetApprovalCandidate({
      manifestPath: fixture.manifestPath,
      approvalPath: fixture.approvalPath,
      pendingPath: fixture.pendingPath,
      now: new Date("2026-08-26T01:30:00.000Z"),
    });
    const pendingBefore = readFileSync(fixture.pendingPath, "utf8");
    writeFileSync(fixture.manifestPath, anonymousRaw, "utf8");
    assert.throws(() => commitLocalAssetApprovalCandidate({
      manifestPath: fixture.manifestPath,
      approvalPath: fixture.approvalPath,
      backupRoot: fixture.backups,
      pendingPath: fixture.pendingPath,
      expectedApprovalSha256: prepared.expectedApprovalSha256,
      candidateApprovalSha256: prepared.candidateApprovalSha256,
      expectedReleaseId: prepared.releaseId,
      now: new Date("2026-08-26T01:30:00.000Z"),
    }), /release revision must be a complete lowercase Git commit digest/u);
    assert.equal(readFileSync(fixture.pendingPath, "utf8"), pendingBefore);
    assert.equal(existsSync(fixture.approvalPath), false);
    assert.deepEqual(readdirSync(fixture.backups), []);
  });
});

test("rejects a malformed revision before changing approval state", () => {
  const fixture = makeFixture();
  const manifest = writeManifest(fixture, "asset-malformed-revision");
  writeFileSync(
    fixture.manifestPath,
    `${JSON.stringify({ ...manifest, revision: "abcdef0" }, null, 2)}\n`,
    "utf8",
  );
  assert.throws(
    () => rotate(fixture, new Date("2026-08-26T01:45:00.000Z")),
    /release revision must be a complete lowercase Git commit digest/u,
  );
  assert.equal(existsSync(fixture.approvalPath), false);
  assert.deepEqual(readdirSync(fixture.backups), []);
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
  assert.equal(prepared.releaseId, JSON.parse(readFileSync(fixture.manifestPath, "utf8")).releaseId);
  assert.equal(readFileSync(fixture.approvalPath, "utf8"), committedBefore);
  assert.equal(mode(fixture.pendingPath), 0o600);
  assert.deepEqual(verifyReleaseAssetApproval({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.pendingPath,
    now: new Date("2026-08-26T05:00:00.000Z"),
  }), expectedVerification(fixture.pendingPath));
  // 模拟随后定义提交失败：不调用 commit，已提交审批和备份必须保持不变。
  // English: The simulation subsequently defines a commit failure: commit is not called, and the submitted
  // approval and backup must remain unchanged.
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
    expectedReleaseId: prepared.releaseId,
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

test("CLI emits and commits one exact six-field release transaction", () => {
  const fixture = makeFixture();
  const manifest = writeManifest(fixture, "asset-cli-transaction");
  const prepared = spawnSync(process.execPath, [
    rotationScript,
    "prepare",
    fixture.manifestPath,
    fixture.approvalPath,
    fixture.pendingPath,
  ], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const fields = prepared.stdout.trim().split(" ");
  assert.equal(fields.length, 6);
  assert.equal(fields[0], "prepared");
  assert.equal(fields[5], manifest.releaseId);

  const committed = spawnSync(process.execPath, [
    rotationScript,
    "commit",
    fixture.manifestPath,
    fixture.approvalPath,
    fixture.backups,
    fixture.pendingPath,
    fields[2],
    fields[3],
    fields[5],
  ], { encoding: "utf8" });
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.stdout, /asset approval: created \(3 exact files\)/u);
  assert.equal(existsSync(fixture.pendingPath), false);
  assert.equal(existsSync(fixture.approvalPath), true);

  const extraArgument = spawnSync(process.execPath, [
    rotationScript,
    "prepare",
    fixture.manifestPath,
    fixture.approvalPath,
    fixture.pendingPath,
    "unexpected",
  ], { encoding: "utf8" });
  assert.notEqual(extraArgument.status, 0);
  assert.match(extraArgument.stderr, /prepare requires manifest, approval, and pending paths/u);
});

test("does not commit the same assets after canonical release identity changes", () => {
  const fixture = makeFixture();
  writeManifest(fixture, "asset-identity-old");
  rotate(fixture, new Date("2026-08-26T07:30:00.000Z"));
  const committedBefore = readFileSync(fixture.approvalPath, "utf8");
  const preparedManifest = writeManifest(
    fixture,
    "asset-identity-a",
    files(digest("f")),
    "1".repeat(40),
  );
  const now = new Date("2026-08-26T08:00:00.000Z");
  const prepared = prepareLocalAssetApprovalCandidate({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    pendingPath: fixture.pendingPath,
    now,
  });
  assert.equal(prepared.releaseId, preparedManifest.releaseId);
  const pendingBefore = readFileSync(fixture.pendingPath, "utf8");
  const backupsBefore = readdirSync(fixture.backups);

  const changedIdentity = writeManifest(
    fixture,
    "asset-identity-b",
    files(digest("f")),
    "2".repeat(40),
  );
  assert.deepEqual(changedIdentity.files, preparedManifest.files);
  assert.notEqual(changedIdentity.releaseId, prepared.releaseId);

  assert.throws(() => commitLocalAssetApprovalCandidate({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    backupRoot: fixture.backups,
    pendingPath: fixture.pendingPath,
    expectedApprovalSha256: prepared.expectedApprovalSha256,
    candidateApprovalSha256: prepared.candidateApprovalSha256,
    expectedReleaseId: prepared.releaseId,
    now,
  }), /release manifest identity changed after candidate validation/u);
  assert.equal(readFileSync(fixture.approvalPath, "utf8"), committedBefore);
  assert.equal(readFileSync(fixture.pendingPath, "utf8"), pendingBefore);
  assert.deepEqual(readdirSync(fixture.backups), backupsBefore);
});

test("rejects a malformed expected releaseId without changing prepared state", () => {
  const fixture = makeFixture();
  writeManifest(fixture, "asset-invalid-expected-id");
  const now = new Date("2026-08-26T08:30:00.000Z");
  const prepared = prepareLocalAssetApprovalCandidate({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    pendingPath: fixture.pendingPath,
    now,
  });
  const pendingBefore = readFileSync(fixture.pendingPath, "utf8");
  assert.throws(() => commitLocalAssetApprovalCandidate({
    manifestPath: fixture.manifestPath,
    approvalPath: fixture.approvalPath,
    backupRoot: fixture.backups,
    pendingPath: fixture.pendingPath,
    expectedApprovalSha256: prepared.expectedApprovalSha256,
    candidateApprovalSha256: prepared.candidateApprovalSha256,
    expectedReleaseId: "invalid-release-id",
    now,
  }), /expected release manifest releaseId is invalid/u);
  assert.equal(readFileSync(fixture.pendingPath, "utf8"), pendingBefore);
  assert.equal(existsSync(fixture.approvalPath), false);
  assert.deepEqual(readdirSync(fixture.backups), []);
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
