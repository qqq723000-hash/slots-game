#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function fail(message) {
  throw new Error(`release version contract: ${message}`);
}

function readRegular(root, relativePath, maximumBytes = 2 * 1024 * 1024) {
  const path = resolve(root, relativePath);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    fail(`${relativePath} must be a non-empty bounded regular file`);
  }
  const content = readFileSync(path, "utf8");
  if (content.charCodeAt(0) === 0xfeff || content.includes("\r")) {
    fail(`${relativePath} must use UTF-8 without BOM and LF line endings`);
  }
  return content;
}

function parseJson(root, relativePath) {
  const content = readRegular(root, relativePath);
  try {
    return JSON.parse(content);
  } catch {
    fail(`${relativePath} must contain valid JSON`);
  }
}

function oneMatch(content, pattern, label) {
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1) fail(`${label} must occur exactly once`);
  return matches[0][1];
}

export function verifyReleaseVersion(projectRoot, { formal = false } = {}) {
  const root = resolve(projectRoot);
  const versionText = readRegular(root, "VERSION", 64);
  if (!versionText.endsWith("\n") || versionText.indexOf("\n") !== versionText.length - 1) {
    fail("VERSION must contain exactly one LF-terminated line");
  }
  const version = versionText.slice(0, -1);
  if (!semverPattern.test(version)) fail("VERSION must be canonical MAJOR.MINOR.PATCH SemVer");

  const changelog = readRegular(root, "CHANGELOG.md");
  const unreleasedOffset = changelog.indexOf("## 未发布\n");
  if (unreleasedOffset < 0) fail("CHANGELOG.md must retain a 未发布 section");
  const releases = [...changelog.matchAll(/^## ([0-9]+\.[0-9]+\.[0-9]+) - ([0-9]{4}-[0-9]{2}-[0-9]{2})(?:（[^\n]+）)?$/gmu)];
  if (releases.length === 0 || releases[0][1] !== version) {
    fail("the newest CHANGELOG.md release must equal VERSION");
  }
  if (releases[0].index <= unreleasedOffset) fail("未发布 must precede the newest formal release");
  const seen = new Set();
  for (const release of releases) {
    if (!semverPattern.test(release[1]) || seen.has(release[1])) fail("CHANGELOG.md release versions must be unique canonical SemVer");
    seen.add(release[1]);
    const date = new Date(`${release[2]}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== release[2]) {
      fail("CHANGELOG.md release dates must be valid ISO calendar dates");
    }
  }
  const unreleasedBody = changelog.slice(
    unreleasedOffset + "## 未发布\n".length,
    releases[0].index,
  );
  if (formal && unreleasedBody.trim() !== "") {
    fail("CHANGELOG.md 未发布 must be empty at a formal delivery commit");
  }

  const packageJson = parseJson(root, "web/package.json");
  if (packageJson.private !== true || packageJson.version !== version) {
    fail("web/package.json must be private and match VERSION");
  }
  const packageLock = parseJson(root, "web/package-lock.json");
  if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) {
    fail("web/package-lock.json root package versions must match VERSION");
  }

  const chart = readRegular(root, "deploy/cluster-production/chart/Chart.yaml", 64 * 1024);
  const chartVersion = oneMatch(chart, /^version: ([^\n]+)$/gmu, "Chart version");
  const appVersion = oneMatch(chart, /^appVersion: "([^"]+)"$/gmu, "Chart appVersion");
  if (chartVersion !== version || appVersion !== version) fail("Chart version and appVersion must match VERSION");

  const openapi = readRegular(root, "server/openapi.yaml", 2 * 1024 * 1024);
  const openapiVersion = oneMatch(openapi, /^  version: ([^\n]+)$/gmu, "OpenAPI info.version");
  if (openapiVersion !== version) fail("OpenAPI info.version must match VERSION");

  for (const readmePath of ["README.md", "web/README.md"]) {
    const readme = readRegular(root, readmePath);
    const documentedVersion = oneMatch(
      readme,
      /^WEB_RELEASE_VERSION=([0-9]+\.[0-9]+\.[0-9]+) \\$/gmu,
      `${readmePath} WEB_RELEASE_VERSION`,
    );
    if (documentedVersion !== version) fail(`${readmePath} release example must match VERSION`);
  }

  return version;
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  const scriptRoot = resolve(dirname(currentPath), "../..");
  let projectRoot = scriptRoot;
  let formal = false;
  const args = process.argv.slice(2);
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--formal" && !formal) {
      formal = true;
    } else if (argument === "--root" && args.length > 0 && projectRoot === scriptRoot) {
      projectRoot = args.shift();
    } else {
      fail("usage: verify-release-version.mjs [--formal] [--root PROJECT_ROOT]");
    }
  }
  const version = verifyReleaseVersion(projectRoot, { formal });
  process.stdout.write(`release version contract: ${version}\n`);
}
