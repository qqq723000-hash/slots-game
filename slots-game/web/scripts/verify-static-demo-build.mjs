import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { verifyReleaseManifest } from "./release-manifest.mjs";

const outputDirectory = new URL("../dist-demo/", import.meta.url);
const requiredFiles = [
  ".nojekyll",
  "index.html",
  "release-manifest.json",
  "static-demo-assets.json",
  "static-demo-manifest.json",
  "THIRD_PARTY_NOTICES.txt",
  "assets/brand/powered-by-gm-go.png",
  "assets/primal-reference/10001.svg",
];
const forbiddenBundlePatterns = [
  /rgsLaunchCode/,
  /rgsOperatorId/,
  /rgsSessionId/,
  /VITE_RGS_BASE_URL/,
  /\/v1\/session\/exchange/,
  /\/v1\/spins/,
  /base-rgs-recovered-level-up/,
  /high-pps-probability-king-exit/,
  /normal-win-continue/,
  /king-flow/,
  /kong-flow/,
  /cap-summary/,
];
const MAX_FILE_COUNT = 256;
const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await filesBelow(new URL(`${entry.name}/`, directory), `${relativePath}/`));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Static demo output contains a non-regular entry: ${relativePath}`);
    }
  }
  return files;
}

for (const relativePath of requiredFiles) {
  const details = await stat(new URL(relativePath, outputDirectory));
  if (!details.isFile()) throw new Error(`Required demo artifact is not a file: ${relativePath}`);
}

const indexHtml = await readFile(new URL("index.html", outputDirectory), "utf8");
for (const phrase of [
  "DEMO",
  "No real money",
  "No wallet",
  "No economic value",
  "Not odds or RTP",
  "No project analytics or personal-data submission",
  "Independent educational recreation",
  "Not affiliated with or endorsed by Play'n GO",
]) {
  if (!indexHtml.includes(phrase)) throw new Error(`Static demo notice is missing: ${phrase}`);
}
const documentReferences = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1]);
for (const reference of documentReferences) {
  const resolved = new URL(reference, "https://pages.invalid/slots-game/");
  if (resolved.origin !== "https://pages.invalid"
    || !resolved.pathname.startsWith("/slots-game/")) {
    throw new Error(`Static demo document escaped the GitHub Pages base path: ${reference}`);
  }
}

const manifest = JSON.parse(
  await readFile(new URL("static-demo-manifest.json", outputDirectory), "utf8"),
);
if (manifest.basePath !== "/slots-game/"
  || manifest.mode !== "deterministic-static-demo"
  || manifest.gateway !== "public-static-demo"
  || manifest.outcomeSelection !== "fixed-public-showcase-loop"
  || manifest.roundCount !== 23
  || manifest.economicMode !== "none"
  || manifest.wallet !== false
  || manifest.rgs !== false
  || manifest.currency !== "XTS"
  || manifest.repositoryAssetRightsEvidence !== "insufficient"
  || manifest.deploymentGate !== "external-exact-hash-approval-required") {
  throw new Error("Static demo manifest does not preserve its non-economic isolation contract");
}

const files = (await filesBelow(outputDirectory)).sort();
if (files.length > MAX_FILE_COUNT) {
  throw new Error(`Static demo output exceeds ${MAX_FILE_COUNT} files`);
}
const fileDetails = await Promise.all(files.map(async (path) => ({
  path,
  bytes: (await stat(new URL(path, outputDirectory))).size,
})));
if (fileDetails.some((entry) => entry.bytes > MAX_SINGLE_FILE_BYTES)) {
  throw new Error("Static demo output contains an oversized file");
}
if (fileDetails.reduce((total, entry) => total + entry.bytes, 0) > MAX_TOTAL_BYTES) {
  throw new Error("Static demo output exceeds the total byte budget");
}
const unexpectedHidden = files.filter((path) => path !== ".nojekyll"
  && path.split("/").some((part) => part.startsWith(".")));
if (unexpectedHidden.length > 0) {
  throw new Error(
    `Static demo output contains a hidden file outside the allow-list: ${unexpectedHidden[0]}`,
  );
}

const releaseManifest = verifyReleaseManifest(JSON.parse(
  await readFile(new URL("release-manifest.json", outputDirectory), "utf8"),
));
const releaseEntries = await Promise.all(files
  .filter((path) => path !== "release-manifest.json")
  .map(async (path) => {
    const bytes = await readFile(new URL(path, outputDirectory));
    return {
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }));
if (JSON.stringify(releaseManifest.files) !== JSON.stringify(releaseEntries)) {
  throw new Error("Static demo release manifest does not close over the exact output tree");
}
const assetBoundary = JSON.parse(
  await readFile(new URL("static-demo-assets.json", outputDirectory), "utf8"),
);
if (assetBoundary.schemaVersion !== 1
  || assetBoundary.policy !== "EXTERNAL_RIGHTS_APPROVAL_REQUIRED"
  || assetBoundary.note !== "This digest inventory is not a license or rights-chain proof."
  || !Array.isArray(assetBoundary.files)
  || assetBoundary.files.length === 0) {
  throw new Error("Static demo protected-asset digest inventory is invalid");
}
const expectedProtectedPaths = files.filter((path) => path.startsWith("assets/primal-runtime/")
  || path.startsWith("assets/primal-reference/") || path.startsWith("assets/brand/"));
const recordedPaths = assetBoundary.files.map((entry) => entry.path);
if (JSON.stringify(recordedPaths) !== JSON.stringify(expectedProtectedPaths)) {
  throw new Error("Static demo protected-asset digest inventory is incomplete or unsorted");
}
const protectedPathSet = new Set(recordedPaths);
const allowedNonProtectedPaths = new Set([
  ".nojekyll",
  "index.html",
  "release-manifest.json",
  "static-demo-assets.json",
  "static-demo-manifest.json",
  "THIRD_PARTY_NOTICES.txt",
]);
const unexpectedOutput = files.filter((path) => !protectedPathSet.has(path)
  && !allowedNonProtectedPaths.has(path)
  && !/^assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(path));
if (unexpectedOutput.length > 0) {
  throw new Error(`Static demo output is outside the positive allow-list: ${unexpectedOutput[0]}`);
}
for (const entry of assetBoundary.files) {
  if (!entry || typeof entry !== "object"
    || Object.keys(entry).sort().join(",") !== "bytes,path,sha256"
    || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
    || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error("Static demo protected-asset digest entry is invalid");
  }
  const bytes = await readFile(new URL(entry.path, outputDirectory));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== entry.bytes || digest !== entry.sha256) {
    throw new Error(`Static demo protected-asset digest mismatch: ${entry.path}`);
  }
}
for (const forbiddenPath of [
  "favicon.ico",
  "assets/primal-runtime/interface/powered-by-playngo.png",
  "assets/primal-runtime/runtime-manifest.json",
  "assets/primal-runtime/streaming-packages.desktop.json",
  "assets/primal-runtime/streaming-packages.mobile.json",
]) {
  if (files.includes(forbiddenPath)) {
    throw new Error(`Static demo output retained a production-only or unused asset: ${forbiddenPath}`);
  }
}
if (files.some((file) => extname(file) === ".map")) {
  throw new Error("Static demo output must not publish source maps");
}
const javascriptFiles = files.filter((file) => extname(file) === ".js");
if (javascriptFiles.length === 0) throw new Error("Static demo JavaScript bundle is missing");
for (const file of javascriptFiles) {
  const source = await readFile(new URL(file, outputDirectory), "utf8");
  for (const pattern of forbiddenBundlePatterns) {
    if (pattern.test(source)) {
      throw new Error(`Static demo bundle contains a production RGS handoff: ${file}`);
    }
  }
}

const searchableFiles = files.filter((file) => [".html", ".js", ".css", ".json"]
  .includes(extname(file)));
for (const file of searchableFiles) {
  const source = await readFile(new URL(file, outputDirectory), "utf8");
  if (/powered-by-playngo|favicon\.ico/i.test(source)) {
    throw new Error(`Static demo output references a removed upstream asset: ${file}`);
  }
}

for (const file of files.filter((path) => [".css", ".js"].includes(extname(path)))) {
  const source = await readFile(new URL(file, outputDirectory), "utf8");
  if (/(["'(])\/assets\//.test(source)) {
    throw new Error(`Static demo bundle contains a repository-root asset URL: ${file}`);
  }
}

console.log(`Static demo contract verified: ${files.length} files under /slots-game/`);
