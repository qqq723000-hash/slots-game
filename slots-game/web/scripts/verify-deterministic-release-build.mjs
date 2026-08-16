#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "./release-manifest.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(webRoot, "dist", "release-manifest.json");

async function verifiedManifestText() {
  const text = await readFile(manifestPath, "utf8");
  verifyReleaseManifest(JSON.parse(text), {
    requireRevision: process.env.WEB_RELEASE_REQUIRE_IDENTITY === "1",
  });
  return text;
}

const reference = await verifiedManifestText();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const rebuild = spawnSync(npmCommand, ["run", "build"], {
  cwd: webRoot,
  env: process.env,
  stdio: "inherit",
});
if (rebuild.error) throw rebuild.error;
if (rebuild.status !== 0) throw new Error(`确定性复建失败，退出码 ${rebuild.status ?? "未知"}`);

const rebuilt = await verifiedManifestText();
if (rebuilt !== reference) {
  throw new Error("相同输入的两次生产构建生成了不同发布清单");
}
const { releaseId } = JSON.parse(rebuilt);
process.stdout.write(`确定性生产构建通过：${releaseId}\n`);
