#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(import.meta.dirname, "..");
const scanRoots = [
  resolve(projectRoot, "server"),
  resolve(projectRoot, "tools"),
  resolve(projectRoot, "infra"),
  resolve(projectRoot, "scripts"),
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
  ".example",
  ".go",
  ".html",
  ".hcl",
  ".js",
  ".mjs",
  ".rb",
  ".sh",
  ".sql",
  ".tf",
  ".tfvars",
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
  return scannedNames.has(name) || name === "Dockerfile" || name.startsWith("Dockerfile.") || scannedExtensions.has(extname(name));
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

function shellHeredocOpeners(line) {
  const openers = [];
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(line[index - 1]))) break;
    if (character !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") continue;

    let cursor = index + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor += 1;
    while (/\s/u.test(line[cursor] ?? "")) cursor += 1;
    let delimiter = "";
    let delimiterQuote = null;
    let delimiterEscaped = false;
    for (; cursor < line.length; cursor += 1) {
      const value = line[cursor];
      if (delimiterEscaped) {
        delimiter += value;
        delimiterEscaped = false;
        continue;
      }
      if (value === "\\" && delimiterQuote !== "'") {
        delimiterEscaped = true;
        continue;
      }
      if (delimiterQuote !== null) {
        if (value === delimiterQuote) delimiterQuote = null;
        else delimiter += value;
        continue;
      }
      if (value === "'" || value === '"') {
        delimiterQuote = value;
        continue;
      }
      if (/\s|[;&|()<>]/u.test(value)) break;
      delimiter += value;
    }
    if (delimiter.length > 0) openers.push({ delimiter, stripTabs });
    index = Math.max(index + 1, cursor - 1);
  }
  return openers;
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
  if ([".go", ".js", ".mjs", ".ts", ".tsx", ".css", ".html", ".hcl", ".tf", ".tfvars"].includes(extension)) {
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
      return trimmed.replace(/\*\/.*$/u, "").replace(/^\*?\s?/u, "").trim();
    }
    if (trimmed.startsWith("/*")) {
      const body = trimmed.replace(/^\/\*+\s?/u, "");
      if (!body.includes("*/")) state.slashBlock = true;
      return body.replace(/\*\/.*$/u, "").trim();
    }
    const slashComment = trimmed.match(/^\/\/\s?(.*)$/u)?.[1];
    if (slashComment !== undefined) return slashComment;
    if ([".hcl", ".tf", ".tfvars"].includes(extension)) {
      return line.match(/^\s*#\s?(.*)$/u)?.[1] ?? null;
    }
    return null;
  }
  if (
    [".conf", ".dockerignore", ".example", ".rb", ".sh", ".tpl", ".yaml", ".yml"].includes(extension) ||
    scannedNames.has(name) ||
    name === "Dockerfile" ||
    name.startsWith("Dockerfile.")
  ) {
    return line.match(/^\s*#\s?(.*)$/u)?.[1] ?? null;
  }
  return null;
}

export function collectHumanCommentBlocks(filePath, source) {
  const blocks = [];
  const state = { htmlBlock: false, slashBlock: false };
  const shellHeredocs = [];
  let current = null;

  const flush = () => {
    if (current !== null) blocks.push(current);
    current = null;
  };

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (extname(filePath) === ".sh" && shellHeredocs.length > 0) {
      const active = shellHeredocs[0];
      const candidate = active.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === active.delimiter) shellHeredocs.shift();
      flush();
      continue;
    }
    if (isMachineDirective(line)) {
      flush();
      continue;
    }
    const text = commentText(filePath, line, state);
    if (text === null) {
      flush();
      if (extname(filePath) === ".sh") shellHeredocs.push(...shellHeredocOpeners(line));
      continue;
    }
    if (current === null) current = { line: index + 1, parts: [] };
    current.parts.push(text);
  }
  flush();
  return blocks.map(({ line, parts }) => ({ line, text: parts.join("\n").trim() }));
}

export function hasSubstantiveEnglishComment(text) {
  const withoutProtocolTerms = text
    .replace(/`[^`]*`/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/gu, " ");
  const hasEnglishLabel = /\bEnglish\s*:/iu.test(withoutProtocolTerms);
  const prose = withoutProtocolTerms.replace(/\bEnglish\s*:/giu, " ");
  const words = prose.match(/\b[A-Za-z][A-Za-z'-]*\b/gu) ?? [];
  if (hasEnglishLabel) return words.length >= 2;
  return (
    words.length >= 4
    && /\b(?:a|an|and|are|as|at|before|by|for|from|if|in|is|must|never|not|of|only|or|should|that|the|this|to|when|while|with)\b/iu.test(prose)
  );
}

export function findBilingualCommentViolations(filePath, source) {
  const violations = [];
  for (const block of collectHumanCommentBlocks(filePath, source)) {
    const hasChinese = /\p{Script=Han}/u.test(block.text);
    const hasEnglishText = /[A-Za-z]{2,}/u.test(block.text);
    const hasEnglish = hasSubstantiveEnglishComment(block.text);
    if (!hasChinese && !hasEnglishText) continue;
    if (!hasChinese) violations.push({ ...block, missing: "Chinese" });
    if (hasChinese && !hasEnglish) violations.push({ ...block, missing: "English" });
  }
  return violations;
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
    const source = await readFile(filePath, "utf8");
    for (const violation of findBilingualCommentViolations(filePath, source)) {
      violations.push(
        `${relative(projectRoot, filePath)}:${violation.line}: missing ${violation.missing}: ${violation.text}`,
      );
    }
  }

  if (violations.length > 0) {
    console.error("发现未提供中英双语说明的人工代码注释块：");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`中英双语注释契约通过：已扫描 ${files.length} 个代码与配置文件。`);
  }
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  await main();
}
