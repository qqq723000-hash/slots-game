import { createHash } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(webRoot, "dist");
const publicRoot = resolve(webRoot, "public");
const checkOnly = process.argv.includes("--check");

import {
  createReleaseManifest,
  UNAVAILABLE_RELEASE_REVISION,
  verifyReleaseManifest,
} from "./release-manifest.mjs";
import {
  assertNoForbiddenProductionSentinels,
  reachableProductionAssets,
} from "./production-asset-graph.mjs";
import { regularFilesUnder } from "./production-file-tree.mjs";

function slash(path) {
  return path.split(sep).join("/");
}

async function referencedPrimalFiles() {
  // 生产引用由源码常量和 CSS 构成。这里只解析已有文件名，不接受任意路径。
  const candidates = await regularFilesUnder(resolve(publicRoot, "assets/primal-reference"));
  const sourceFiles = (await regularFilesUnder(resolve(webRoot, "src"))).filter((path) => {
    const sourceName = slash(relative(webRoot, path));
    return /\.(?:ts|css)$/.test(sourceName) && !sourceName.startsWith("src/testing/");
  });
  const source = (await Promise.all(sourceFiles.map((path) => readFile(path, "utf8")))).join("\n");
  return new Set(candidates.filter((path) => source.includes(path.split(sep).at(-1))).map((path) => slash(relative(publicRoot, path))));
}

async function expectedPaths() {
  const keep = new Set([
    "index.html",
    "favicon.ico",
    "THIRD_PARTY_NOTICES.txt",
    "browser-preflight.js",
  ]);
  const distributionFiles = await regularFilesUnder(distRoot);
  const moduleArtifacts = [];
  for (const path of distributionFiles) {
    const name = slash(relative(distRoot, path));
    if (/^assets\/[^/]+\.(?:m?js|css)$/.test(name)) {
      moduleArtifacts.push({ name, source: await readFile(path, "utf8") });
    }
    if (name.startsWith("assets/primal-runtime/")) keep.add(name);
  }
  assertNoForbiddenProductionSentinels(moduleArtifacts);
  const indexSource = await readFile(resolve(distRoot, "index.html"), "utf8");
  for (const name of reachableProductionAssets(indexSource, moduleArtifacts)) keep.add(name);
  for (const name of await referencedPrimalFiles()) keep.add(name);
  return keep;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function releaseEntries() {
  const releaseFiles = (await regularFilesUnder(distRoot))
    .map((path) => ({ path, name: slash(relative(distRoot, path)) }))
    .filter(({ name }) => name !== "release-manifest.json");
  const entries = [];
  for (const file of releaseFiles) {
    entries.push({ path: file.name, bytes: (await stat(file.path)).size, sha256: await sha256(file.path) });
  }
  return entries;
}

async function defaultVersion() {
  const packageMetadata = JSON.parse(await readFile(resolve(webRoot, "package.json"), "utf8"));
  return packageMetadata.version;
}

function exactEntries(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const keep = await expectedPaths();
const before = (await regularFilesUnder(distRoot)).map((path) => slash(relative(distRoot, path)));
const forbidden = before.filter((name) =>
  name.endsWith(".map") ||
  /(^|\/)README(?:\.[^/]*)?$/i.test(name) ||
  /(^|\/)(?:screenshots?|captures?|tests?|tmp)(\/|$)/i.test(name)
);

if (checkOnly) {
  const unexpected = before.filter((name) => name !== "release-manifest.json" && !keep.has(name));
  if (unexpected.length || forbidden.length) {
    throw new Error(`发布目录含非白名单文件:\n${[...new Set([...unexpected, ...forbidden])].join("\n")}`);
  }
  const manifest = verifyReleaseManifest(
    JSON.parse(await readFile(resolve(distRoot, "release-manifest.json"), "utf8")),
  );
  const entries = await releaseEntries();
  if (!exactEntries(manifest.files, entries)) {
    throw new Error("发布清单与当前目录的文件摘要不一致");
  }
  process.stdout.write(`生产发布目录校验通过：${before.length} 个文件。\n`);
  process.exit(0);
}

for (const name of before) {
  if (name !== "release-manifest.json" && !keep.has(name)) {
    await rm(resolve(distRoot, name));
  }
}

const entries = await releaseEntries();
const requireRevision = process.env.WEB_RELEASE_REQUIRE_IDENTITY === "1";
if (process.env.WEB_RELEASE_REQUIRE_IDENTITY !== undefined && !["0", "1"].includes(process.env.WEB_RELEASE_REQUIRE_IDENTITY)) {
  throw new Error("WEB_RELEASE_REQUIRE_IDENTITY 只能是 0 或 1");
}
const manifest = createReleaseManifest({
  version: process.env.WEB_RELEASE_VERSION ?? await defaultVersion(),
  revision: process.env.WEB_RELEASE_REVISION ?? UNAVAILABLE_RELEASE_REVISION,
  files: entries,
  requireRevision,
});
const manifestPath = resolve(distRoot, "release-manifest.json");
const temporaryManifestPath = `${manifestPath}.tmp-${process.pid}`;
try {
  await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryManifestPath, manifestPath);
} catch (error) {
  await rm(temporaryManifestPath, { force: true });
  throw error;
}
process.stdout.write(`生产发布白名单已生成：保留 ${entries.length} 个文件，排除 ${before.length - entries.length} 个文件。\n`);
