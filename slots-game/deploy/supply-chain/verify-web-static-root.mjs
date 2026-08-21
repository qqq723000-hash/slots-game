#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_KEYS = Object.freeze(["files", "releaseId", "revision", "schemaVersion", "version"]);
const FILE_KEYS = Object.freeze(["bytes", "path", "sha256"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VERSION_PATTERN = /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/;

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
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

function parseManifest(value) {
  const manifest = plainObject(value, "release manifest");
  exactKeys(manifest, MANIFEST_KEYS, "release manifest");
  if (manifest.schemaVersion !== 1) fail("release manifest schemaVersion must be 1");
  if (typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version)) {
    fail("release manifest version is invalid");
  }
  if (typeof manifest.revision !== "string" || !REVISION_PATTERN.test(manifest.revision)) {
    fail("release manifest revision is not a complete source digest");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("release manifest files must be a non-empty array");
  }

  const files = manifest.files.map((value, index) => {
    const entry = plainObject(value, `release manifest files[${index}]`);
    exactKeys(entry, FILE_KEYS, `release manifest files[${index}]`);
    const path = normalizedPath(entry.path, `release manifest files[${index}].path`);
    if (path === "release-manifest.json") fail("release manifest must not include itself");
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail(`release manifest files[${index}].bytes must be a non-negative safe integer`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      fail(`release manifest files[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    return { path, bytes: entry.bytes, sha256: entry.sha256 };
  });

  const sorted = [...files].sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  for (let index = 0; index < sorted.length; index += 1) {
    if (files[index].path !== sorted[index].path) fail("release manifest files are not in canonical path order");
    if (index > 0 && sorted[index - 1].path === sorted[index].path) {
      fail("release manifest files contain a duplicate path");
    }
  }

  const payload = JSON.stringify({
    schemaVersion: 1,
    version: manifest.version,
    revision: manifest.revision,
    files,
  });
  const expectedReleaseId = `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
  if (manifest.releaseId !== expectedReleaseId) fail("release manifest releaseId does not match its canonical content");
  return { ...manifest, files };
}

function slash(path) {
  return path.split(sep).join("/");
}

async function regularFilesUnder(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => {
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) fail("extracted Web root contains a symbolic link");
      if (metadata.isDirectory()) {
        await visit(path);
      } else if (metadata.isFile()) {
        files.push({ path, bytes: metadata.size });
      } else {
        fail("extracted Web root contains a non-regular filesystem entry");
      }
    }
  }
  await visit(root);
  return files;
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyWebStaticRoot(rootPath) {
  const root = resolve(rootPath);
  const rootMetadata = await lstat(root).catch(() => fail("extracted Web root cannot be read"));
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail("extracted Web root must be a real directory");
  }

  const manifestPath = resolve(root, "release-manifest.json");
  const manifestMetadata = await lstat(manifestPath).catch(() => fail("release-manifest.json is missing"));
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
    fail("release-manifest.json must be a regular file");
  }
  let manifestJson;
  try {
    manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("release-manifest.json is not valid JSON");
  }
  const manifest = parseManifest(manifestJson);
  const expectedFiles = new Map(manifest.files.map((entry) => [entry.path, entry]));

  const actualFiles = await regularFilesUnder(root);
  for (const actual of actualFiles) {
    const name = slash(relative(root, actual.path));
    if (name === "release-manifest.json") continue;
    const expected = expectedFiles.get(name);
    if (!expected) fail("extracted Web root contains a file outside release-manifest");
    if (actual.bytes !== expected.bytes) fail("extracted Web file byte length does not match release-manifest");
    if (await fileSha256(actual.path) !== expected.sha256) {
      fail("extracted Web file SHA-256 does not match release-manifest");
    }
    expectedFiles.delete(name);
  }
  if (expectedFiles.size !== 0) fail("extracted Web root is missing a release-manifest file");
  return manifest;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv.length !== 3) {
    process.stderr.write(`usage: ${basename(process.argv[1])} STATIC_ROOT\n`);
    process.exitCode = 2;
  } else {
    verifyWebStaticRoot(process.argv[2]).then((manifest) => {
      process.stdout.write(`Web 静态根逐文件校验通过：${manifest.releaseId}，${manifest.files.length} 个文件。\n`);
    }).catch((error) => {
      process.stderr.write(`Web 静态根校验失败：${error instanceof Error ? error.message : "unexpected error"}\n`);
      process.exitCode = 1;
    });
  }
}
