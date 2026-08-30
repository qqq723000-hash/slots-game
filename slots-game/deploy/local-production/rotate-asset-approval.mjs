import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "../../web/scripts/release-manifest.mjs";
import { isProtectedReleaseAsset } from "../../web/scripts/verify-release-asset-approval.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const LOCAL_APPROVAL_REFERENCE = "user-authorized-local-technical-production";
const LOCAL_JURISDICTION = "LOCAL";
const APPROVAL_KEYS = Object.freeze([
  "approvalReference",
  "assets",
  "expiresAt",
  "jurisdictions",
  "schemaVersion",
  "status",
]);
const ASSET_KEYS = Object.freeze(["bytes", "path", "sha256"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RELEASE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export class LocalAssetApprovalRotationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalAssetApprovalRotationError";
  }
}

function fail(message) {
  throw new LocalAssetApprovalRotationError(message);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unsupported fields`);
  }
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function readJSON(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`${label} cannot be read`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { raw, value };
}

function secureDirectory(path, label) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(`${label} cannot be inspected`);
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
    fail(`${label} must be a real 0700 directory`);
  }
}

function restrictedRegularFile(path, label) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail(`${label} cannot be inspected`);
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    fail(`${label} must be a real 0600 file`);
  }
  if (info.size <= 0 || info.size > 8 * 1024 * 1024) {
    fail(`${label} has an invalid size`);
  }
  return true;
}

function normalizedProtectedPath(value, label) {
  if (typeof value !== "string" || !isProtectedReleaseAsset(value)
      || value.startsWith("/") || value.includes("\\")
      || value.split("/").some((part) => part === "" || part === "." || part === "..")
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a normalized protected release asset path`);
  }
  return value;
}

function normalizeApprovalAsset(value, label) {
  const asset = plainObject(value, label);
  exactKeys(asset, ASSET_KEYS, label);
  const path = normalizedProtectedPath(asset.path, `${label}.path`);
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0) {
    fail(`${label}.bytes must be a non-negative safe integer`);
  }
  if (typeof asset.sha256 !== "string" || !SHA256_PATTERN.test(asset.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  return { path, bytes: asset.bytes, sha256: asset.sha256 };
}

function validateExistingLocalApproval(raw, value, now) {
  const approval = plainObject(value, "release asset approval");
  exactKeys(approval, APPROVAL_KEYS, "release asset approval");
  // 本地生成器始终输出这种规范编码；强制要求该编码还能拒绝会被
  // JSON.parse 折叠的重复 JSON 键。
  // English: Local generators always output this canonical encoding; forcing this encoding will reject
  // JSON.parse collapses duplicate JSON keys.
  if (raw !== `${JSON.stringify(approval, null, 2)}\n`) {
    fail("release asset approval is not canonical local JSON");
  }
  if (approval.schemaVersion !== 1) fail("release asset approval schemaVersion must be 1");
  if (approval.status !== "APPROVED") fail("release asset approval status must be APPROVED");
  if (approval.approvalReference !== LOCAL_APPROVAL_REFERENCE) {
    fail("release asset approval is not owned by the local technical authority");
  }
  if (!Array.isArray(approval.jurisdictions)
      || approval.jurisdictions.length !== 1
      || approval.jurisdictions[0] !== LOCAL_JURISDICTION) {
    fail("release asset approval jurisdictions are not the local technical scope");
  }
  if (typeof approval.expiresAt !== "string") fail("release asset approval expiration is invalid");
  const expiration = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiration) || new Date(expiration).toISOString() !== approval.expiresAt) {
    fail("release asset approval expiration is invalid");
  }
  if (!Array.isArray(approval.assets) || approval.assets.length === 0 || approval.assets.length > 100_000) {
    fail("release asset approval assets must be a bounded non-empty array");
  }
  const assets = approval.assets.map((entry, index) => (
    normalizeApprovalAsset(entry, `release asset approval assets[${index}]`)
  ));
  for (let index = 0; index < assets.length; index += 1) {
    if (index > 0 && assets[index - 1].path >= assets[index].path) {
      fail("release asset approval assets must use unique canonical path order");
    }
  }
  return { assets, expired: expiration <= now.getTime() };
}

function protectedManifestAssets(manifest) {
  const assets = manifest.files.filter((entry) => isProtectedReleaseAsset(entry.path));
  if (assets.length === 0) fail("release manifest contains no protected assets");
  return assets.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
}

function sameAssets(left, right) {
  return left.length === right.length && left.every((asset, index) => (
    asset.path === right[index].path
    && asset.bytes === right[index].bytes
    && asset.sha256 === right[index].sha256
  ));
}

function targetApproval(assets, now) {
  const expiration = new Date(now.getTime());
  expiration.setUTCFullYear(expiration.getUTCFullYear() + 1);
  return {
    schemaVersion: 1,
    status: "APPROVED",
    approvalReference: LOCAL_APPROVAL_REFERENCE,
    jurisdictions: [LOCAL_JURISDICTION],
    expiresAt: expiration.toISOString(),
    assets,
  };
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusiveRestricted(path, contents) {
  let descriptor;
  let completed = false;
  try {
    descriptor = openSync(path, "wx", 0o600);
    chmodSync(path, 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    completed = true;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* cleanup continues with the exclusive path */ }
    }
    if (!completed) {
      try { unlinkSync(path); } catch { /* the exclusive open may have failed before creation */ }
    }
  }
}

function createApprovalBackup(backupRoot, raw, now) {
  const timestamp = now.toISOString().replace(/[-:.]/gu, "");
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  const baseName = `asset-approval-rotation-${timestamp}-${digest}`;
  let backupDirectory;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName}-${String(attempt).padStart(2, "0")}`;
    const candidate = resolve(backupRoot, name);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      chmodSync(candidate, 0o700);
      backupDirectory = candidate;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") fail("release asset approval backup cannot be created");
    }
  }
  if (!backupDirectory) fail("release asset approval backup name space is exhausted");

  const backupPath = resolve(backupDirectory, "release-asset-approval.json");
  let completed = false;
  try {
    writeExclusiveRestricted(backupPath, raw);
    if (readFileSync(backupPath, "utf8") !== raw) fail("release asset approval backup verification failed");
    syncDirectory(backupDirectory);
    syncDirectory(backupRoot);
    completed = true;
    return backupDirectory;
  } finally {
    if (!completed) {
      try { unlinkSync(backupPath); } catch { /* newly created backup may not contain a file */ }
      try { rmdirSync(backupDirectory); } catch { /* retain evidence if cleanup cannot be proven safe */ }
    }
  }
}

function replaceApprovalAtomically(path, contents, expectedRaw) {
  const parent = dirname(path);
  const temporary = resolve(
    parent,
    `.release-asset-approval-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let temporaryExists = false;
  try {
    writeExclusiveRestricted(temporary, contents);
    temporaryExists = true;
    const exists = restrictedRegularFile(path, "release asset approval");
    if (expectedRaw === null) {
      if (exists) fail("release asset approval appeared during creation");
    } else {
      if (!exists || readFileSync(path, "utf8") !== expectedRaw) {
        fail("release asset approval changed during rotation");
      }
    }
    renameSync(temporary, path);
    temporaryExists = false;
    syncDirectory(parent);
  } finally {
    if (temporaryExists) {
      try { unlinkSync(temporary); } catch { /* temporary is restricted and uniquely named */ }
    }
  }
}

export function rotateLocalAssetApproval({
  manifestPath,
  approvalPath,
  backupRoot,
  now = new Date(),
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("asset approval clock is invalid");
  if (![manifestPath, approvalPath, backupRoot].every((value) => (
    typeof value === "string" && value.trim() !== ""
  ))) {
    fail("manifest, approval, and backup paths are required");
  }
  const resolvedManifest = resolve(manifestPath);
  const resolvedApproval = resolve(approvalPath);
  const resolvedBackupRoot = resolve(backupRoot);
  const approvalParent = dirname(resolvedApproval);
  secureDirectory(approvalParent, "release asset approval parent");
  secureDirectory(resolvedBackupRoot, "release asset approval backup root");
  const backupFromApproval = relative(approvalParent, resolvedBackupRoot);
  const approvalFromBackup = relative(resolvedBackupRoot, approvalParent);
  const nested = (value) => value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
  if (nested(backupFromApproval) || nested(approvalFromBackup)) {
    fail("release asset approval backup root must be separate from its parent");
  }

  const { assets } = manifestState(resolvedManifest);
  const replacement = `${JSON.stringify(targetApproval(assets, now), null, 2)}\n`;

  const exists = restrictedRegularFile(resolvedApproval, "release asset approval");
  if (!exists) {
    replaceApprovalAtomically(resolvedApproval, replacement, null);
    return { action: "created", approvedAssets: assets.length };
  }

  const existing = readJSON(resolvedApproval, "release asset approval");
  const validated = validateExistingLocalApproval(existing.raw, existing.value, now);
  if (!validated.expired && sameAssets(validated.assets, assets)) {
    return { action: "unchanged", approvedAssets: assets.length };
  }

  const backupDirectory = createApprovalBackup(resolvedBackupRoot, existing.raw, now);
  replaceApprovalAtomically(resolvedApproval, replacement, existing.raw);
  return {
    action: validated.expired ? "rotated-expired" : "rotated-manifest",
    approvedAssets: assets.length,
    backupDirectory,
  };
}

function manifestState(manifestPath) {
  let manifest;
  try {
    manifest = verifyReleaseManifest(
      readJSON(resolve(manifestPath), "release manifest").value,
      { requireRevision: true },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : "release manifest is invalid");
  }
  return {
    releaseId: manifest.releaseId,
    assets: protectedManifestAssets(manifest),
  };
}

function sha256(contents) {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function validatePendingPath(approvalPath, pendingPath) {
  const resolvedApproval = resolve(approvalPath);
  const resolvedPending = resolve(pendingPath);
  if (resolvedApproval === resolvedPending) {
    fail("pending release asset approval must not replace the committed approval");
  }
  secureDirectory(dirname(resolvedApproval), "release asset approval parent");
  secureDirectory(dirname(resolvedPending), "pending release asset approval parent");
  return { resolvedApproval, resolvedPending };
}

/**
 * 生成可独立验证的候选审批，但不修改已提交审批或备份。bootstrap 可先构建全部
// English: Generates independently verifiable candidate approvals without modifying submitted approvals or
// backups. bootstrap can build all first Candidate image; if the subsequent gate definition fails, the old
// approval will remain unchanged byte by byte.
 * 候选镜像；若后续定义门禁失败，旧审批仍保持逐字节不变。
 */
export function prepareLocalAssetApprovalCandidate({
  manifestPath,
  approvalPath,
  pendingPath,
  now = new Date(),
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("asset approval clock is invalid");
  if (![manifestPath, approvalPath, pendingPath].every((value) => (
    typeof value === "string" && value.trim() !== ""
  ))) {
    fail("manifest, approval, and pending paths are required");
  }
  const { resolvedApproval, resolvedPending } = validatePendingPath(approvalPath, pendingPath);
  const { releaseId, assets } = manifestState(manifestPath);
  const existingPresent = restrictedRegularFile(resolvedApproval, "release asset approval");
  let expectedApprovalSha256 = "-";
  let action = "created";
  let candidate = `${JSON.stringify(targetApproval(assets, now), null, 2)}\n`;
  if (existingPresent) {
    const existing = readJSON(resolvedApproval, "release asset approval");
    const validated = validateExistingLocalApproval(existing.raw, existing.value, now);
    expectedApprovalSha256 = sha256(existing.raw);
    if (!validated.expired && sameAssets(validated.assets, assets)) {
      action = "unchanged";
      candidate = existing.raw;
    } else {
      action = validated.expired ? "rotated-expired" : "rotated-manifest";
    }
  }

  const pendingPresent = restrictedRegularFile(resolvedPending, "pending release asset approval");
  const expectedPending = pendingPresent ? readFileSync(resolvedPending, "utf8") : null;
  replaceApprovalAtomically(resolvedPending, candidate, expectedPending);
  return {
    action,
    approvedAssets: assets.length,
    expectedApprovalSha256,
    candidateApprovalSha256: sha256(candidate),
    releaseId,
  };
}

/**
 * 仅提交先前验证过的候选。预期摘要把“准备”和“提交”绑定到同一份已提交审批，
// English: Only submit previously verified candidates. The expected digest binds "prepare" and "submit" to the
// same document submitted for approval, Even manual changes to bypass native lockf will fail the shutdown.
 * 即使有绕过本机 lockf 的手工改动也会失败关闭。
 */
export function commitLocalAssetApprovalCandidate({
  manifestPath,
  approvalPath,
  backupRoot,
  pendingPath,
  expectedApprovalSha256,
  candidateApprovalSha256,
  expectedReleaseId,
  now = new Date(),
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("asset approval clock is invalid");
  if (![manifestPath, approvalPath, backupRoot, pendingPath].every((value) => (
    typeof value === "string" && value.trim() !== ""
  ))) {
    fail("manifest, approval, backup, and pending paths are required");
  }
  if (expectedApprovalSha256 !== "-" && !SHA256_PATTERN.test(expectedApprovalSha256)) {
    fail("expected release asset approval digest is invalid");
  }
  if (!SHA256_PATTERN.test(candidateApprovalSha256)) {
    fail("candidate release asset approval digest is invalid");
  }
  if (typeof expectedReleaseId !== "string" || !RELEASE_ID_PATTERN.test(expectedReleaseId)) {
    fail("expected release manifest releaseId is invalid");
  }

  const { resolvedApproval, resolvedPending } = validatePendingPath(approvalPath, pendingPath);
  const resolvedBackupRoot = resolve(backupRoot);
  secureDirectory(resolvedBackupRoot, "release asset approval backup root");
  const approvalParent = dirname(resolvedApproval);
  const backupFromApproval = relative(approvalParent, resolvedBackupRoot);
  const approvalFromBackup = relative(resolvedBackupRoot, approvalParent);
  const nested = (value) => value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
  if (nested(backupFromApproval) || nested(approvalFromBackup)) {
    fail("release asset approval backup root must be separate from its parent");
  }

  const { releaseId, assets } = manifestState(manifestPath);
  if (releaseId !== expectedReleaseId) {
    fail("release manifest identity changed after candidate validation");
  }
  if (!restrictedRegularFile(resolvedPending, "pending release asset approval")) {
    fail("pending release asset approval cannot be read");
  }
  const pending = readJSON(resolvedPending, "pending release asset approval");
  if (sha256(pending.raw) !== candidateApprovalSha256) {
    fail("pending release asset approval changed after validation");
  }
  const validatedPending = validateExistingLocalApproval(pending.raw, pending.value, now);
  if (validatedPending.expired || !sameAssets(validatedPending.assets, assets)) {
    fail("pending release asset approval does not match the current manifest");
  }

  const existingPresent = restrictedRegularFile(resolvedApproval, "release asset approval");
  let existingRaw = null;
  let existingValidation = null;
  if (expectedApprovalSha256 === "-") {
    if (existingPresent) fail("release asset approval appeared after candidate validation");
  } else {
    if (!existingPresent) fail("release asset approval disappeared after candidate validation");
    const existing = readJSON(resolvedApproval, "release asset approval");
    if (sha256(existing.raw) !== expectedApprovalSha256) {
      fail("release asset approval changed after candidate validation");
    }
    existingValidation = validateExistingLocalApproval(existing.raw, existing.value, now);
    existingRaw = existing.raw;
  }

  let action = "created";
  if (existingValidation) {
    if (pending.raw === existingRaw) action = "unchanged";
    else action = existingValidation.expired ? "rotated-expired" : "rotated-manifest";
  }
  if (pending.raw !== existingRaw) {
    if (existingRaw !== null) createApprovalBackup(resolvedBackupRoot, existingRaw, now);
    replaceApprovalAtomically(resolvedApproval, pending.raw, existingRaw);
  }
  unlinkSync(resolvedPending);
  syncDirectory(dirname(resolvedPending));
  return { action, approvedAssets: assets.length };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const [command, ...arguments_] = process.argv.slice(2);
  try {
    if (command === "prepare") {
      if (arguments_.length !== 3) {
        fail("prepare requires manifest, approval, and pending paths");
      }
      const [manifestPath, approvalPath, pendingPath] = arguments_;
      const result = prepareLocalAssetApprovalCandidate({ manifestPath, approvalPath, pendingPath });
      process.stdout.write([
        "prepared",
        result.action,
        result.expectedApprovalSha256,
        result.candidateApprovalSha256,
        result.approvedAssets,
        result.releaseId,
      ].join(" ") + "\n");
    } else if (command === "commit") {
      if (arguments_.length !== 7) {
        fail("commit requires manifest, approval, backup, pending, two approval digests, and releaseId");
      }
      const [
        manifestPath,
        approvalPath,
        backupRoot,
        pendingPath,
        expectedApprovalSha256,
        candidateApprovalSha256,
        expectedReleaseId,
      ] = arguments_;
      const result = commitLocalAssetApprovalCandidate({
        manifestPath,
        approvalPath,
        backupRoot,
        pendingPath,
        expectedApprovalSha256,
        candidateApprovalSha256,
        expectedReleaseId,
      });
      process.stdout.write(
        `local production asset approval: ${result.action} (${result.approvedAssets} exact files)\n`,
      );
    } else {
      if (typeof command !== "string" || command === "" || arguments_.length !== 2) {
        fail("rotation requires manifest, approval, and backup paths");
      }
      const [approvalPath, backupRoot] = arguments_;
      const result = rotateLocalAssetApproval({
        manifestPath: command,
        approvalPath,
        backupRoot,
      });
      process.stdout.write(
        `local production asset approval: ${result.action} (${result.approvedAssets} exact files)\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected rotation failure";
    process.stderr.write(`local production asset approval: ${message}\n`);
    process.exitCode = 1;
  }
}
