import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "./release-manifest.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(scriptPath), "..");

const APPROVAL_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "approvalReference",
  "jurisdictions",
  "expiresAt",
  "assets",
]);
const ASSET_KEYS = Object.freeze(["path", "bytes", "sha256"]);

export const PROTECTED_RELEASE_ASSET_PREFIXES = Object.freeze([
  "assets/primal-runtime/",
  "assets/primal-reference/",
  "assets/brand/",
]);
export const PROTECTED_RELEASE_ASSET_EXACT_PATHS = Object.freeze([
  "favicon.ico",
]);

export function isProtectedReleaseAsset(path) {
  return PROTECTED_RELEASE_ASSET_EXACT_PATHS.includes(path)
    || PROTECTED_RELEASE_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export class ReleaseAssetApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseAssetApprovalError";
  }
}

function fail(message) {
  throw new ReleaseAssetApprovalError(message);
}

function readJson(path, label) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    fail(`${label} cannot be read`);
  }

  try {
    return { contents, value: JSON.parse(contents) };
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const supported = [...expected].sort();
  if (actual.length !== supported.length || actual.some((key, index) => key !== supported[index])) {
    fail(`${label} contains unsupported fields`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value;
}

function safeByteLength(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function protectedPath(value, label) {
  nonEmptyString(value, label);
  if (!isProtectedReleaseAsset(value)) {
    fail(`${label} must match a protected release asset selector`);
  }
  if (value.includes("\\") || value.split("/").some((part) => part === "." || part === "..")) {
    fail(`${label} must be a normalized release asset path`);
  }
  return value;
}

function assetRecord(value, label) {
  const record = object(value, label);
  exactKeys(record, ASSET_KEYS, label);
  return {
    path: protectedPath(record.path, `${label}.path`),
    bytes: safeByteLength(record.bytes, `${label}.bytes`),
    sha256: sha256(record.sha256, `${label}.sha256`),
  };
}

function indexUniqueAssets(entries, label) {
  const records = new Map();
  entries.forEach((entry, index) => {
    const record = assetRecord(entry, `${label}[${index}]`);
    if (records.has(record.path)) fail(`${label} contains a duplicate asset path`);
    records.set(record.path, record);
  });
  return records;
}

function canonicalApproval(approval, assets) {
  return {
    schemaVersion: approval.schemaVersion,
    status: approval.status,
    approvalReference: approval.approvalReference,
    jurisdictions: approval.jurisdictions,
    expiresAt: approval.expiresAt,
    assets,
  };
}

function requireCanonicalJson(contents, approval, assets) {
  // 这是仓库审批生成器输出的编码。逐字节比较还能检测重复对象键，
  // 因为 JSON.parse 会在其他情况下将它们静默折叠为最后一个值。
  const canonical = `${JSON.stringify(canonicalApproval(approval, assets), null, 2)}\n`;
  if (contents !== canonical) fail("release asset approval is not canonical JSON");
}

function expiration(value, now) {
  const text = nonEmptyString(value, "approval.expiresAt");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
    fail("approval.expiresAt must be an ISO-8601 UTC timestamp");
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) fail("approval.expiresAt must be a valid timestamp");
  const canonicalWithMilliseconds = new Date(timestamp).toISOString();
  const canonicalWithoutMilliseconds = canonicalWithMilliseconds.replace(".000Z", "Z");
  if (text !== canonicalWithMilliseconds && text !== canonicalWithoutMilliseconds) {
    fail("approval.expiresAt must be a valid timestamp");
  }
  if (timestamp <= now.getTime()) fail("approval has expired");
}

function validateJurisdictions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("approval.jurisdictions must be a non-empty array");
  }
  const jurisdictions = new Set();
  value.forEach((jurisdiction, index) => {
    const normalized = nonEmptyString(jurisdiction, `approval.jurisdictions[${index}]`).trim();
    if (jurisdictions.has(normalized)) fail("approval.jurisdictions contains a duplicate value");
    jurisdictions.add(normalized);
  });
}

/**
 * 用密钥挂载提供的外部审批核对本次网络构建生成的精确清单。审批格式刻意保持封闭：
 * schemaVersion 1，以及状态、approvalReference、司法管辖区、expiresAt 和资产[{路径, 字节数, sha256}]；
 * 禁止用宽松字段或仓库内占位文件替代真实授权。
 */
export function verifyReleaseAssetApproval({
  manifestPath = resolve(webRoot, "dist", "release-manifest.json"),
  approvalPath = process.env.RELEASE_ASSET_APPROVAL_FILE ?? "",
  now = new Date(),
  requiredJurisdiction = null,
} = {}) {
  if (typeof approvalPath !== "string" || approvalPath.trim() === "") {
    fail("RELEASE_ASSET_APPROVAL_FILE is required for a release build");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("release approval clock is invalid");

  let manifest;
  try {
    manifest = verifyReleaseManifest(readJson(manifestPath, "release manifest").value);
  } catch (error) {
    fail(error instanceof Error ? error.message : "release manifest is invalid");
  }

  const protectedEntries = manifest.files.filter((entry) => (
    entry && typeof entry.path === "string"
      && isProtectedReleaseAsset(entry.path)
  ));
  if (protectedEntries.length === 0) fail("release manifest contains no protected release assets");
  const manifestAssets = indexUniqueAssets(protectedEntries, "release manifest protected files");

  const approvalDocument = readJson(approvalPath, "release asset approval");
  const approval = object(approvalDocument.value, "release asset approval");
  exactKeys(approval, APPROVAL_KEYS, "release asset approval");
  if (approval.schemaVersion !== 1) fail("approval.schemaVersion must be 1");
  if (approval.status !== "APPROVED") fail("approval.status must be APPROVED");
  nonEmptyString(approval.approvalReference, "approval.approvalReference");
  validateJurisdictions(approval.jurisdictions);
  if (requiredJurisdiction !== null) {
    const jurisdiction = nonEmptyString(requiredJurisdiction, "requiredJurisdiction").trim();
    if (!approval.jurisdictions.includes(jurisdiction)) {
      fail(`approval.jurisdictions must explicitly include ${jurisdiction}`);
    }
  }
  expiration(approval.expiresAt, now);
  if (!Array.isArray(approval.assets)) fail("approval.assets must be an array");
  const approvalAssets = indexUniqueAssets(approval.assets, "approval.assets");
  requireCanonicalJson(approvalDocument.contents, approval, [...approvalAssets.values()]);

  for (const [path, manifestAsset] of manifestAssets) {
    const approvedAsset = approvalAssets.get(path);
    if (!approvedAsset) fail("approval does not cover protected release asset");
    if (approvedAsset.bytes !== manifestAsset.bytes) {
      fail("approval byte length does not match release manifest");
    }
    if (approvedAsset.sha256 !== manifestAsset.sha256) {
      fail("approval hash does not match release manifest");
    }
  }
  if (approvalAssets.size !== manifestAssets.size) {
    fail("approval contains an asset outside the protected release manifest");
  }

  return { approvedAssets: manifestAssets.size, expiresAt: approval.expiresAt };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const { approvedAssets } = verifyReleaseAssetApproval();
    process.stdout.write(`release asset approval: ok (${approvedAssets} protected assets)\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected validation error";
    process.stderr.write(`release asset approval: ${message}\n`);
    process.exitCode = 1;
  }
}
