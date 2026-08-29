import { createHash } from "node:crypto";

export const UNAVAILABLE_RELEASE_REVISION = "unavailable";

const MANIFEST_KEYS = Object.freeze([
  "files",
  "releaseId",
  "revision",
  "schemaVersion",
  "version",
]);
const FILE_KEYS = Object.freeze(["bytes", "path", "sha256"]);
const VERSION_PATTERN = /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class ReleaseManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseManifestError";
  }
}

function fail(message) {
  throw new ReleaseManifestError(message);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unsupported fields`);
  }
}

function normalizedPath(value, label) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")) {
    fail(`${label} must be a normalized relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..") || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a normalized relative path`);
  }
  return value;
}

function fileRecord(value, label) {
  const record = plainObject(value, label);
  exactKeys(record, FILE_KEYS, label);
  const path = normalizedPath(record.path, `${label}.path`);
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
    fail(`${label}.bytes must be a non-negative safe integer`);
  }
  if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  return { path, bytes: record.bytes, sha256: record.sha256 };
}

function comparePaths(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function normalizedFiles(value, { requireCanonicalOrder }) {
  if (!Array.isArray(value) || value.length === 0) fail("release manifest files must be a non-empty array");
  const files = value.map((entry, index) => fileRecord(entry, `release manifest files[${index}]`));
  const sorted = [...files].sort(comparePaths);
  for (let index = 0; index < sorted.length; index += 1) {
    if (index > 0 && sorted[index - 1].path === sorted[index].path) {
      fail("release manifest files contain a duplicate path");
    }
    if (requireCanonicalOrder && files[index].path !== sorted[index].path) {
      fail("release manifest files are not in canonical path order");
    }
  }
  return sorted;
}

function publicVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    fail("release version must be 1-128 safe ASCII version characters");
  }
  return value;
}

function publicRevision(value, { allowUnavailable }) {
  if (allowUnavailable && value === UNAVAILABLE_RELEASE_REVISION) return value;
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    fail("release revision must be a complete lowercase Git commit digest");
  }
  return value;
}

/**
 * 公开发布身份只允许版本号与完整提交摘要。字段集合保持封闭，避免把构建主机、时间、
 * 工作目录或环境变量意外写入浏览器可读取的发布清单。
 *
 * 英文 / English: Public release status only allows version numbers and full commit summaries. Field collections are kept closed to avoid accidentally writing build host, time, working directory, or environment variables to the browser-readable release manifest.
 */
export function normalizePublicReleaseIdentity({ version, revision, requireRevision = false }) {
  return {
    version: publicVersion(version),
    revision: publicRevision(revision, { allowUnavailable: !requireRevision }),
  };
}

function canonicalPayload({ version, revision, files }) {
  return JSON.stringify({ schemaVersion: 1, version, revision, files });
}

function releaseIdFor(payload) {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/**
 * releaseId 由规范化清单内容复算，明确排除它自身以避免循环定义。输入顺序不会影响
 * 输出；任何文件字节、公开版本或提交摘要变化都会生成新的发布身份。
 *
 * 英文 / English: releaseId is recalculated from the contents of the normalized manifest, explicitly excluding itself to avoid circular definitions. Input order does not affect output; any file bytes, public version, or commit summary changes will generate a new release identity.
 */
export function createReleaseManifest({ version, revision, files, requireRevision = false }) {
  const identity = normalizePublicReleaseIdentity({ version, revision, requireRevision });
  const normalized = normalizedFiles(files, { requireCanonicalOrder: false });
  const payload = canonicalPayload({ ...identity, files: normalized });
  return {
    schemaVersion: 1,
    releaseId: releaseIdFor(payload),
    ...identity,
    files: normalized,
  };
}

/**
 * 校验浏览器或副本探针取得的清单时拒绝未知字段、非规范顺序和无法复算的 releaseId，
 * 防止代理比较了一个可伪造的标签却忽略实际文件内容。
 *
 * 英文 / English: Reject unknown fields, non-canonical sequences, and releaseIds that cannot be recalculated when validating the manifest obtained by the browser or replica probe, preventing the agent from comparing a forged tag but ignoring the actual file content.
 */
export function verifyReleaseManifest(value, { requireRevision = false } = {}) {
  const manifest = plainObject(value, "release manifest");
  exactKeys(manifest, MANIFEST_KEYS, "release manifest");
  if (manifest.schemaVersion !== 1) fail("release manifest schemaVersion must be 1");
  const identity = normalizePublicReleaseIdentity({
    version: manifest.version,
    revision: manifest.revision,
    requireRevision,
  });
  const files = normalizedFiles(manifest.files, { requireCanonicalOrder: true });
  const expectedId = releaseIdFor(canonicalPayload({ ...identity, files }));
  if (manifest.releaseId !== expectedId) fail("release manifest releaseId does not match its canonical content");
  return { schemaVersion: 1, releaseId: expectedId, ...identity, files };
}
