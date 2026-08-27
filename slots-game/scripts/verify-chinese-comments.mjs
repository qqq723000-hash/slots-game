#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(import.meta.dirname, "..");
const scanRoots = [
  resolve(projectRoot, "server"),
  resolve(projectRoot, "web/src"),
  resolve(projectRoot, "web/scripts"),
  resolve(projectRoot, "web/tests"),
  resolve(projectRoot, "deploy"),
  resolve(projectRoot, "Makefile"),
  resolve(projectRoot, ".editorconfig"),
  resolve(projectRoot, ".gitattributes"),
  resolve(projectRoot, ".gitignore"),
  resolve(projectRoot, "../.gitignore"),
  resolve(projectRoot, "../.github"),
];

const ignoredDirectories = new Set([".git", "node_modules", "dist", ".artifacts"]);
const scannedExtensions = new Set([
  ".conf",
  ".css",
  ".dockerignore",
  ".go",
  ".html",
  ".js",
  ".mjs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".tpl",
  ".yaml",
  ".yml",
]);
const scannedNames = new Set([
  "Dockerfile",
  "Makefile",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "env.example",
]);

function isScannedFile(filePath) {
  const name = basename(filePath);
  return scannedNames.has(name) || name.endsWith("Dockerfile") || scannedExtensions.has(extname(name));
}

function isMachineDirective(line) {
  return (
    /^\s*#!/u.test(line) ||
    /^\s*#\s*(?:syntax=|shellcheck\b|hadolint\b)/u.test(line) ||
    /^\s*\/\/\s*(?:go:build\b|go:embed\b|\+build\b|nolint\b|lint:|Code generated\b)/u.test(line) ||
    /^\s*\/\/\s*@(slider|image)\b/u.test(line) ||
    /^\s*\/\*\s*(?:eslint|stylelint)\b/u.test(line)
  );
}

export function splitHtmlCommentEnd(value) {
  const standardEnd = value.indexOf("-->");
  const legacyBangEnd = value.indexOf("--!>");
  const candidates = [standardEnd, legacyBangEnd].filter((index) => index >= 0);
  const end = candidates.length === 0 ? -1 : Math.min(...candidates);
  return { body: end < 0 ? value : value.slice(0, end), ended: end >= 0 };
}

function commentText(filePath, line, state) {
  const extension = extname(filePath);
  const name = basename(filePath);
  if (extension === ".sql") {
    return line.match(/^\s*--\s?(.*)$/u)?.[1] ?? null;
  }
  if ([".go", ".js", ".mjs", ".ts", ".tsx", ".css", ".html"].includes(extension)) {
    const trimmed = line.trimStart();
    if (state.htmlBlock) {
      const comment = splitHtmlCommentEnd(trimmed);
      if (comment.ended) state.htmlBlock = false;
      return comment.body.trim();
    }
    if (trimmed.startsWith("<!--")) {
      const comment = splitHtmlCommentEnd(trimmed.slice(4));
      if (!comment.ended) state.htmlBlock = true;
      return comment.body.trim();
    }
    if (state.slashBlock) {
      const end = trimmed.includes("*/");
      if (end) state.slashBlock = false;
      return trimmed.replace(/^\*?\s?/u, "").replace(/\*\/.*$/u, "").trim();
    }
    if (trimmed.startsWith("/*")) {
      const body = trimmed.replace(/^\/\*+\s?/u, "");
      if (!body.includes("*/")) state.slashBlock = true;
      return body.replace(/\*\/.*$/u, "").trim();
    }
    return trimmed.match(/^\/\/\s?(.*)$/u)?.[1] ?? null;
  }
  if (
    [".conf", ".dockerignore", ".sh", ".tpl", ".yaml", ".yml"].includes(extension) ||
    scannedNames.has(name) ||
    name.endsWith("Dockerfile")
  ) {
    return line.match(/^\s*#\s?(.*)$/u)?.[1] ?? null;
  }
  return null;
}

async function collectFiles(entryPath, files) {
  const entries = await readdir(entryPath, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOTDIR") {
      if (isScannedFile(entryPath)) files.push(entryPath);
      return null;
    }
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (entries === null) return;

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childPath = resolve(entryPath, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await collectFiles(childPath, files);
      continue;
    }
    if (entry.isFile() && isScannedFile(childPath)) files.push(childPath);
  }
}

async function main() {
  const files = [];
  for (const root of scanRoots) await collectFiles(root, files);
  files.sort();

  const violations = [];
  for (const filePath of files) {
    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/u);
    const state = { htmlBlock: false, slashBlock: false };
    for (const [index, line] of lines.entries()) {
      if (isMachineDirective(line)) continue;
      const text = commentText(filePath, line, state);
      if (text === null || !/[A-Za-z]{2,}/u.test(text) || /\p{Script=Han}/u.test(text)) continue;
      violations.push(`${relative(projectRoot, filePath)}:${index + 1}: ${text.trim()}`);
    }
  }

  if (violations.length > 0) {
    console.error("发现未使用中文说明的人工代码注释：");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`中文注释契约通过：已扫描 ${files.length} 个代码与配置文件。`);
  }
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  await main();
}
