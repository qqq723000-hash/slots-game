import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { init, parse } from "es-module-lexer";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = resolve(webRoot, "dist");
export const REVIEWED_INLINE_SCRUB_CSP_SOURCE =
  "'sha256-vUs+nbdxmdqOL3f/mZqTupLfHkYf373z+iYtj/+kHtM='";

/**
 * HTML 标签名不区分大小写，因此候选收集接受 SCRIPT/Script；后续精确小写匹配会
 * 拒绝所有非规范入口，不能让大小写变体从“三个脚本”的计数中消失。
 */
export function verifyReviewedIndexSource(indexSource) {
  if (typeof indexSource !== "string" || indexSource === "") {
    throw new Error("生产 HTML 必须是非空 UTF-8 文本");
  }
  const scriptTags = [...indexSource.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu)]
    .map((match) => match[0]);
  const inlineScrubTag = scriptTags[0] ?? "";
  const preflightTag = scriptTags[1] ?? "";
  const moduleTag = scriptTags[2] ?? "";
  const inlineOpeningTag = '<script id="launch-fragment-scrub">';
  const scriptClosingTag = "</script>";
  const inlineScrubCanonical = inlineScrubTag.startsWith(inlineOpeningTag)
    && inlineScrubTag.endsWith(scriptClosingTag);
  const inlineScrubSource = inlineScrubCanonical
    ? inlineScrubTag.slice(inlineOpeningTag.length, -scriptClosingTag.length)
    : null;
  const preflightOpeningTag = '<script src="';
  const preflightClosingTag = '"></script>';
  const preflightCanonical = preflightTag.startsWith(preflightOpeningTag)
    && preflightTag.endsWith(preflightClosingTag);
  const preflightUrl = preflightCanonical
    ? preflightTag.slice(preflightOpeningTag.length, -preflightClosingTag.length)
    : null;
  const moduleSourceMatches = [...moduleTag.matchAll(/\ssrc="([^"]+)"/gu)];
  const moduleOpeningEnd = moduleTag.indexOf(">");
  const moduleCanonical = moduleTag.startsWith('<script type="module"')
    && moduleTag.endsWith(scriptClosingTag)
    && moduleOpeningEnd >= 0
    && moduleTag.slice(moduleOpeningEnd + 1, -scriptClosingTag.length) === ""
    && moduleSourceMatches.length === 1;
  const moduleUrl = moduleCanonical ? moduleSourceMatches[0][1] : null;

  if (scriptTags.length !== 3 || inlineScrubSource === null
    || preflightUrl === null || !preflightUrl.endsWith("browser-preflight.js")
    || preflightUrl.includes('"') || moduleUrl === null
    || indexSource.indexOf(inlineScrubTag) >= indexSource.indexOf(preflightTag)
    || indexSource.indexOf(preflightTag) >= indexSource.indexOf(moduleTag)) {
    throw new Error(
      "生产 HTML 必须且只能依次执行内联片段清理、经典浏览器 preflight 和唯一模块入口",
    );
  }
  if (/\bnomodule\b/u.test(preflightTag)) {
    throw new Error("浏览器 preflight 必须在所有浏览器中先执行");
  }

  const inlineScrubCspSource = `'sha256-${createHash("sha256")
    .update(inlineScrubSource, "utf8").digest("base64")}'`;
  if (inlineScrubCspSource !== REVIEWED_INLINE_SCRUB_CSP_SOURCE) {
    throw new Error("生产内联片段清理器字节与审核过的 CSP hash 不一致");
  }
  if (!inlineScrubSource.includes('Object.defineProperty(window, "__slotsEarlyLaunchHandoff"')
    || !inlineScrubSource.includes("window.history.replaceState")
    || !inlineScrubSource.includes("Object.freeze({")
    || !inlineScrubSource.includes("originalPageUrl = \"\"")
    || inlineScrubSource.indexOf("window.history.replaceState")
      >= inlineScrubSource.indexOf('Object.defineProperty(window, "__slotsEarlyLaunchHandoff"')
    || /\b(?:console|localStorage|sessionStorage)\b/u.test(inlineScrubSource)) {
    throw new Error("生产内联片段清理器没有保持同步清理、锁定一次性交接和静默焚毁契约");
  }

  return Object.freeze({
    inlineScrubCspSource,
    moduleUrl,
    preflightUrl,
  });
}

async function main() {
  const distributionRealRoot = await realpath(distributionRoot);
  const indexSource = await readFile(resolve(distributionRoot, "index.html"), "utf8");
  const reviewedIndex = verifyReviewedIndexSource(indexSource);
  const preflightPath = await confinedDistributionPath(
    reviewedIndex.preflightUrl,
    distributionRealRoot,
  );
  const modulePath = await confinedDistributionPath(
    reviewedIndex.moduleUrl,
    distributionRealRoot,
  );
  const [publicPreflight, builtPreflight, moduleSource] = await Promise.all([
    readFile(resolve(webRoot, "public/browser-preflight.js"), "utf8"),
    readFile(preflightPath, "utf8"),
    readFile(modulePath, "utf8"),
  ]);
  if (builtPreflight !== publicPreflight) {
    throw new Error("生产浏览器 preflight 与已审查的经典脚本字节不一致");
  }
  verifyFallbackPreflightSource(builtPreflight);

  await init;
  const [imports] = parse(moduleSource);
  const staticImports = imports.filter((entry) => entry.d === -1);
  if (staticImports.length > 0) {
    throw new Error("生产模块入口在 preflight 交接前包含静态依赖图");
  }
  const dynamicImports = imports.filter((entry) => entry.d >= 0);
  if (dynamicImports.length !== 1) {
    throw new Error("生产模块入口必须且只能在 preflight 交接后动态装配一个应用模块");
  }

  const manifest = JSON.parse(await readFile(
    resolve(distributionRoot, "release-manifest.json"),
    "utf8",
  ));
  if (!Array.isArray(manifest.files)
    || !manifest.files.some((entry) => entry?.path === "browser-preflight.js")) {
    throw new Error("生产发布清单没有绑定浏览器 preflight");
  }

  process.stdout.write(
    `生产浏览器 preflight 契约通过：内联清理已由 ${reviewedIndex.inlineScrubCspSource} 锁定，能力先检测，模块入口无静态应用依赖。\n`,
  );
}

function verifyFallbackPreflightSource(builtPreflight) {
  const fallbackFunctionStart = builtPreflight.indexOf(
    "  function scrubFallbackLaunchFragment() {",
  );
  const fallbackFunctionEnd = builtPreflight.indexOf(
    "\n  function supportsRequiredBrowser() {",
    fallbackFunctionStart,
  );
  if (fallbackFunctionStart < 0 || fallbackFunctionEnd < 0) {
    throw new Error("生产浏览器 preflight 缺少受限的片段净化兜底");
  }
  const fallbackFunctionSource = builtPreflight.slice(
    fallbackFunctionStart,
    fallbackFunctionEnd,
  );
  const preflightWithoutFallbackFunction = builtPreflight.slice(0, fallbackFunctionStart)
    + builtPreflight.slice(fallbackFunctionEnd);
  const fallbackCall = "if (!scrubFallbackLaunchFragment()) return;";
  const invalidHandoffStart = builtPreflight.indexOf("if (!earlyDetailValid) {");
  const fallbackCallIndex = builtPreflight.indexOf(fallbackCall);
  const fallbackPublishIndex = builtPreflight.indexOf(
    "publishPreflight(false, false, function () { return null; });",
    invalidHandoffStart,
  );
  const fallbackFailureIndex = builtPreflight.indexOf(
    "presentBootstrapFailure();",
    invalidHandoffStart,
  );
  const fallbackLocationMembers = [...fallbackFunctionSource.matchAll(
    /window\.location\.(hash|pathname|search|replace)/gu,
  )].map((match) => match[1]);
  if (!builtPreflight.includes("window.__slotsEarlyLaunchHandoff")
    || !builtPreflight.includes("earlyState.take()")
    || invalidHandoffStart < 0
    || fallbackCallIndex < invalidHandoffStart
    || fallbackCallIndex >= fallbackPublishIndex
    || fallbackPublishIndex >= fallbackFailureIndex
    || builtPreflight.split(fallbackCall).length !== 2
    || JSON.stringify(fallbackLocationMembers)
      !== JSON.stringify(["hash", "pathname", "search", "replace"])
    || !fallbackFunctionSource.includes("window.history.replaceState")
    || !fallbackFunctionSource.includes('decodedKey === "rgsLaunchCode"')
    || !fallbackFunctionSource.includes('decodedKey === "rgsOperatorId"')
    || !fallbackFunctionSource.includes('decodedKey === "rgsSessionId"')
    || !fallbackFunctionSource.includes("return false;")
    || /window\.location\.href/u.test(fallbackFunctionSource)
    || /\b(?:console|fetch|localStorage|navigator\.sendBeacon|sessionStorage|XMLHttpRequest)\b/u
      .test(fallbackFunctionSource)
    || /window\.location\.(?:href|hash|pathname|search|replace)/u
      .test(preflightWithoutFallbackFunction)) {
    throw new Error(
      "生产浏览器 preflight 必须只在无有效 early handoff 时按键净化片段，并在导航后立即返回",
    );
  }
}

async function confinedDistributionPath(urlValue, distributionRealRoot) {
  const parsed = new URL(urlValue, "https://release.invalid/");
  if (parsed.origin !== "https://release.invalid" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("生产 HTML 包含非同源或非规范脚本入口");
  }
  const candidate = resolve(distributionRoot, `.${decodeURIComponent(parsed.pathname)}`);
  const candidateRelative = relative(distributionRoot, candidate);
  if (candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`)) {
    throw new Error("生产 HTML 脚本入口越过发布目录");
  }
  const real = await realpath(candidate);
  const realRelative = relative(distributionRealRoot, real);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`)) {
    throw new Error("生产 HTML 脚本入口通过链接越过发布目录");
  }
  return real;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "生产浏览器 preflight 校验失败"}\n`,
    );
    process.exitCode = 1;
  });
}
