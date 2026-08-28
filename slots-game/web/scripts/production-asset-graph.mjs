import { posix } from "node:path";

import { init, parse } from "es-module-lexer";

await init;

export const FORBIDDEN_PRODUCTION_SENTINELS = Object.freeze([
  "presentation-only-no-rgs-settlement",
  "VisualFixtureGateway",
  "visual-fixtures",
]);

function normalizedAssetName(name) {
  const normalized = posix.normalize(name.replaceAll("\\", "/")).replace(/^\.\//u, "");
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || posix.isAbsolute(normalized)
    || !normalized.startsWith("assets/")
  ) {
    throw new Error(`生产资源名称越出 assets 目录：${name}`);
  }
  return normalized;
}

function localAssetReference(importerName, specifier) {
  let parsed;
  try {
    parsed = new URL(specifier, `https://release.invalid/${importerName}`);
  } catch {
    throw new Error(`生产资源包含非法引用：${importerName} -> ${specifier}`);
  }
  if (parsed.origin !== "https://release.invalid") return null;
  if (!parsed.pathname.startsWith("/assets/")) return null;
  return normalizedAssetName(decodeURIComponent(parsed.pathname.slice(1)));
}

function indexAssetReferences(indexSource) {
  const references = [];
  for (const match of indexSource.matchAll(/\b(?:src|href)="([^"]+)"/gu)) {
    const reference = localAssetReference("index.html", match[1]);
    if (reference !== null && /\.(?:m?js|css)$/iu.test(reference)) references.push(reference);
  }
  return references;
}

export function assertNoForbiddenProductionSentinels(artifacts) {
  const violations = [];
  for (const artifact of artifacts) {
    const name = normalizedAssetName(artifact.name);
    for (const sentinel of FORBIDDEN_PRODUCTION_SENTINELS) {
      if (artifact.source.includes(sentinel)) violations.push(`${name}: ${sentinel}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`正式发布资源含表现夹具标记：\n${violations.sort().join("\n")}`);
  }
}

/**
 * 返回生产 index.html 直接引用、并经静态或字面量动态 import 可达的 JS/CSS。
 * 未从正式入口可达的孤立测试分块不会进入发布白名单。
 */
export function reachableProductionAssets(indexSource, artifacts) {
  const sources = new Map();
  for (const artifact of artifacts) {
    const name = normalizedAssetName(artifact.name);
    if (sources.has(name)) throw new Error(`生产资源名称重复：${name}`);
    sources.set(name, artifact.source);
  }

  const pending = indexAssetReferences(indexSource);
  if (!pending.some((name) => /\.(?:m?js)$/iu.test(name))) {
    throw new Error("生产首页没有同源 JavaScript 模块入口");
  }

  const reachable = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (reachable.has(name)) continue;
    const source = sources.get(name);
    if (source === undefined) throw new Error(`生产入口引用缺少对应资源：${name}`);
    reachable.add(name);
    if (!/\.(?:m?js)$/iu.test(name)) continue;

    let imports;
    try {
      [imports] = parse(source);
    } catch (error) {
      throw new Error(`无法解析生产 JavaScript 资源 ${name}`, { cause: error });
    }
    for (const entry of imports) {
      const specifier = entry.n;
      if (typeof specifier !== "string") continue;
      const dependency = localAssetReference(name, specifier);
      if (dependency === null || !/\.(?:m?js|css)$/iu.test(dependency)) continue;
      pending.push(dependency);
    }
  }
  return reachable;
}
