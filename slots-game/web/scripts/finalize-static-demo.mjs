import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReleaseManifest,
  UNAVAILABLE_RELEASE_REVISION,
} from "./release-manifest.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(webRoot, "dist-demo");
const publicDirectory = resolve(webRoot, "public");
const runtimeManifestPath = resolve(
  publicDirectory,
  "assets/primal-runtime/runtime-manifest.json",
);
const publicAssetAllowListPath = resolve(
  webRoot,
  "demo/static-demo-public-assets.json",
);
const removedPublicPaths = new Set([
  "favicon.ico",
  "assets/primal-runtime/interface/powered-by-playngo.png",
  "assets/primal-runtime/runtime-manifest.json",
  "assets/primal-runtime/streaming-packages.desktop.json",
  "assets/primal-runtime/streaming-packages.mobile.json",
]);
const demoMetadata = Object.freeze({
  schemaVersion: 1,
  mode: "deterministic-static-demo",
  basePath: "/slots-game/",
  gateway: "public-static-demo",
  outcomeSelection: "fixed-public-showcase-loop",
  roundCount: 23,
  currency: "XTS",
  economicMode: "none",
  wallet: false,
  rgs: false,
  repositoryAssetRightsEvidence: "insufficient",
  deploymentGate: "external-exact-hash-approval-required",
});

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (entry.isFile()) output.push(path);
    else throw new Error(`Static demo input contains a non-regular entry: ${path}`);
  }
  return output.sort();
}

async function assetRecord(path) {
  const bytes = await readFile(path);
  return {
    path: path.slice(outputDirectory.length + 1).split(sep).join("/"),
    bytes: (await stat(path)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function collectRuntimeRecords(value, records = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectRuntimeRecords(entry, records);
    return records;
  }
  if (!value || typeof value !== "object") return records;
  if (Object.hasOwn(value, "publicUrl")) records.push(value);
  for (const entry of Object.values(value)) collectRuntimeRecords(entry, records);
  return records;
}

function outputRelativePath(path) {
  return path.slice(outputDirectory.length + 1).split(sep).join("/");
}

const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
if (runtimeManifest.schemaVersion !== 3
  || runtimeManifest.assetSet !== "primal-rampage-runtime") {
  throw new Error("Static demo runtime manifest identity is invalid");
}
const runtimeRecords = collectRuntimeRecords(runtimeManifest);
if (runtimeRecords.length === 0) {
  throw new Error("Static demo runtime manifest contains no public asset records");
}
const approvedRuntimePaths = new Set();
for (const record of runtimeRecords) {
  if (typeof record.publicUrl !== "string"
    || !record.publicUrl.startsWith("/assets/primal-runtime/")
    || record.publicUrl.includes("\\")
    || record.publicUrl.includes("//")
    || record.publicUrl.includes("?")
    || record.publicUrl.includes("#")
    || record.publicUrl.split("/").includes("..")
    || !Number.isSafeInteger(record.bytes)
    || record.bytes < 0
    || typeof record.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error("Static demo runtime manifest contains an invalid asset record");
  }
  const relativePath = record.publicUrl.slice(1);
  if (approvedRuntimePaths.has(relativePath)) {
    throw new Error(`Static demo runtime manifest contains a duplicate asset: ${relativePath}`);
  }
  approvedRuntimePaths.add(relativePath);
  const bytes = await readFile(resolve(publicDirectory, relativePath));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== record.bytes || digest !== record.sha256) {
    throw new Error(`Static demo runtime manifest digest mismatch: ${relativePath}`);
  }
}

// 公共参考素材与项目品牌文件刻意使用显式清单。两个目录下新增的任何未评审文件
// 都必须令构建失败，不能仅因 Vite 复制了整个 public 目录就被公开。
const publicAssetAllowList = JSON.parse(await readFile(publicAssetAllowListPath, "utf8"));
if (!publicAssetAllowList || typeof publicAssetAllowList !== "object"
  || Array.isArray(publicAssetAllowList)
  || Object.keys(publicAssetAllowList).sort().join(",") !== "brand,primalReference,schemaVersion"
  || publicAssetAllowList.schemaVersion !== 1
  || JSON.stringify(publicAssetAllowList.brand) !== JSON.stringify([
    "assets/brand/powered-by-gm-go.png",
    "assets/brand/statusbar-gm-go.png",
  ])
  || !Array.isArray(publicAssetAllowList.primalReference)
  || publicAssetAllowList.primalReference.length === 0) {
  throw new Error("Static demo public asset allow-list is invalid");
}
const retainedPrimalReferencePaths = new Set();
for (const [index, relativePath] of publicAssetAllowList.primalReference.entries()) {
  if (typeof relativePath !== "string"
    || !/^assets\/primal-reference\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:avif|png|svg)$/.test(relativePath)
    || retainedPrimalReferencePaths.has(relativePath)
    || (index > 0 && publicAssetAllowList.primalReference[index - 1] >= relativePath)) {
    throw new Error("Static demo primal-reference allow-list must be unique, sorted, and flat");
  }
  retainedPrimalReferencePaths.add(relativePath);
}
const actualPrimalReferencePaths = (await filesBelow(
  resolve(outputDirectory, "assets/primal-reference"),
)).map(outputRelativePath);
if (JSON.stringify(actualPrimalReferencePaths) !== JSON.stringify([...retainedPrimalReferencePaths])) {
  throw new Error("Static demo primal-reference directory differs from its exact allow-list");
}

for (const relativePath of removedPublicPaths) {
  await rm(resolve(outputDirectory, relativePath), { force: true });
}

// Vite 会在本收尾器运行前复制已配置的 public 目录。公开 Demo 只允许清单绑定的
// 运行素材、源码引用的视觉素材、两个项目品牌标记，以及构建文档精确引用的
// 生成 JS/CSS 文件，其余文件一律失败关闭。
const builtIndex = await readFile(resolve(outputDirectory, "index.html"), "utf8");
const generatedBundlePaths = new Set();
for (const match of builtIndex.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const reference = match[1];
  if (!reference.startsWith(demoMetadata.basePath)) continue;
  const relativePath = reference.slice(demoMetadata.basePath.length);
  if (!/^assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(relativePath)) {
    throw new Error(`Static demo document contains an unexpected generated asset: ${reference}`);
  }
  generatedBundlePaths.add(relativePath);
}
if (generatedBundlePaths.size === 0) {
  throw new Error("Static demo document does not reference a generated bundle");
}
const allowedOutputPaths = new Set([
  "index.html",
  "THIRD_PARTY_NOTICES.txt",
  ...publicAssetAllowList.brand,
  ...generatedBundlePaths,
  ...retainedPrimalReferencePaths,
  ...[...approvedRuntimePaths].filter((path) => !removedPublicPaths.has(path)),
]);
for (const path of await filesBelow(outputDirectory)) {
  const relativePath = outputRelativePath(path);
  if (!allowedOutputPaths.has(relativePath)) {
    throw new Error(`Static demo output is outside the positive allow-list: ${relativePath}`);
  }
}
for (const relativePath of allowedOutputPaths) {
  await stat(resolve(outputDirectory, relativePath));
}

await mkdir(outputDirectory, { recursive: true });
const protectedAssets = (await filesBelow(resolve(outputDirectory, "assets")))
  .filter((path) => path.includes(`${sep}primal-runtime${sep}`)
    || path.includes(`${sep}primal-reference${sep}`)
    || path.includes(`${sep}brand${sep}`));
const assetBoundary = Object.freeze({
  schemaVersion: 1,
  policy: "EXTERNAL_RIGHTS_APPROVAL_REQUIRED",
  note: "This digest inventory is not a license or rights-chain proof.",
  files: await Promise.all(protectedAssets.map(assetRecord)),
});
await Promise.all([
  writeFile(resolve(outputDirectory, ".nojekyll"), "", "utf8"),
  writeFile(
    resolve(outputDirectory, "static-demo-manifest.json"),
    `${JSON.stringify(demoMetadata, null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(outputDirectory, "static-demo-assets.json"),
    `${JSON.stringify(assetBoundary, null, 2)}\n`,
    "utf8",
  ),
]);

const releaseFiles = (await filesBelow(outputDirectory))
  .filter((path) => path !== resolve(outputDirectory, "release-manifest.json"));
const releaseEntries = await Promise.all(releaseFiles.map(assetRecord));
const requireRevision = process.env.WEB_RELEASE_REQUIRE_IDENTITY === "1";
if (process.env.WEB_RELEASE_REQUIRE_IDENTITY !== undefined
  && !["0", "1"].includes(process.env.WEB_RELEASE_REQUIRE_IDENTITY)) {
  throw new Error("WEB_RELEASE_REQUIRE_IDENTITY must be 0 or 1 for the static demo");
}
const packageMetadata = JSON.parse(await readFile(resolve(webRoot, "package.json"), "utf8"));
const releaseManifest = createReleaseManifest({
  version: process.env.WEB_RELEASE_VERSION ?? packageMetadata.version,
  revision: process.env.WEB_RELEASE_REVISION ?? UNAVAILABLE_RELEASE_REVISION,
  files: releaseEntries,
  requireRevision,
});
await writeFile(
  resolve(outputDirectory, "release-manifest.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
  "utf8",
);

const publicCount = (await filesBelow(publicDirectory)).length;
const demoCount = (await filesBelow(outputDirectory)).length;
process.stdout.write(`Static demo asset boundary: ${demoCount} files retained from ${publicCount} public inputs plus bundles.\n`);
