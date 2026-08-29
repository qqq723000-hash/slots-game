#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { PERSONAL_PROJECT_NOTICE } from "./verify-personal-project-docs.mjs";

export const HARDENING_CHECKLIST_TITLE = "# 前后端持续优化加固清单";
export const HARDENING_CHECKLIST_ENGLISH_SUMMARY_HEADING = "## English summary / 英文摘要";
export const HARDENING_CHECKLIST_MINIMUM_ITEMS = 933;
export const HARDENING_CHECKLIST_SECTIONS = Object.freeze([
  "前端架构",
  "前端运行时安全",
  "前端协议与资金状态",
  "前端可靠性与生命周期",
  "前端性能与资源",
  "前端布局、体验与可访问性",
  "前端测试与发布门禁",
  "后端架构与 API",
  "后端身份与应用安全",
  "后端资金正确性",
  "后端数据与并发",
  "后端容量、韧性与故障恢复",
  "后端日志、指标与追踪",
  "后端测试与发布门禁",
  "容器与 Kubernetes",
  "云、网络与边缘",
  "可观测性与告警",
  "供应链与发布",
  "数据保护、备份与灾难恢复",
  "运维与治理",
  "外部上线门禁",
]);

const MAXIMUM_CHECKLIST_BYTES = 512 * 1024;
const MAXIMUM_NAME_CODE_POINTS = 96;

export function validateHardeningChecklist(source, options = {}) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAXIMUM_CHECKLIST_BYTES) {
    throw new Error("加固清单缺失或超过 512 KiB 上限");
  }
  if (source.includes("\r") || source.startsWith("\uFEFF")) {
    throw new Error("加固清单必须使用无 BOM 的 LF UTF-8 文本");
  }

  const requiredSections = options.requiredSections ?? HARDENING_CHECKLIST_SECTIONS;
  const minimumItems = options.minimumItems ?? HARDENING_CHECKLIST_MINIMUM_ITEMS;
  const canonicalPreamble = `${HARDENING_CHECKLIST_TITLE}\n\n${PERSONAL_PROJECT_NOTICE}\n\n`;
  let checklistSource = source;
  if (source.startsWith(canonicalPreamble)) {
    let body = source.slice(canonicalPreamble.length);
    if (body.startsWith(`${HARDENING_CHECKLIST_ENGLISH_SUMMARY_HEADING}\n`)) {
      const summaryMatch = body.match(
        /^## English summary \/ 英文摘要\n\n([^\n]+(?:\n[^\n]+)*)\n\n(?=## )/u,
      );
      if (summaryMatch === null) {
        throw new Error("加固清单英文摘要格式不符合固定契约");
      }
      const summary = summaryMatch[1];
      const englishWords = summary.match(/\b[A-Za-z][A-Za-z'-]*\b/gu) ?? [];
      const sentenceCount = summary.match(/[.!?](?=\s|$)/gu)?.length ?? 0;
      if (/\p{Script=Han}/u.test(summary) || englishWords.length < 20 || sentenceCount < 3) {
        throw new Error("加固清单英文摘要必须包含至少三句实质英文说明");
      }
      body = body.slice(summaryMatch[0].length);
    }
    checklistSource = `${HARDENING_CHECKLIST_TITLE}\n\n${body}`;
  }
  const lines = checklistSource.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== HARDENING_CHECKLIST_TITLE) {
    throw new Error("加固清单标题不符合固定契约");
  }

  const sections = [];
  const itemNames = new Set();
  const itemCountBySection = new Map();
  let activeSection = null;
  let itemCount = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") continue;
    if (line.startsWith("## ")) {
      const name = line.slice(3);
      if (name.length === 0 || name !== name.trim() || sections.includes(name)) {
        throw new Error(`第 ${index + 1} 行包含空白或重复分组`);
      }
      sections.push(name);
      activeSection = name;
      itemCountBySection.set(name, 0);
      continue;
    }
    if (!line.startsWith("- ") || activeSection === null) {
      throw new Error(`第 ${index + 1} 行不是名称条目`);
    }
    const name = line.slice(2);
    const codePointLength = [...name].length;
    if (name.length === 0 || name !== name.trim() || codePointLength > MAXIMUM_NAME_CODE_POINTS) {
      throw new Error(`第 ${index + 1} 行的名称为空、含边缘空白或过长`);
    }
    if (/[。！？；：,.!?;:]$/u.test(name)) {
      throw new Error(`第 ${index + 1} 行包含说明句而不是名称`);
    }
    if (itemNames.has(name)) {
      throw new Error(`加固清单包含重复名称：${name}`);
    }
    itemNames.add(name);
    itemCount += 1;
    itemCountBySection.set(activeSection, itemCountBySection.get(activeSection) + 1);
  }

  if (sections.length !== requiredSections.length
    || sections.some((section, index) => section !== requiredSections[index])) {
    throw new Error("加固清单分组缺失、顺序漂移或出现未审核分组");
  }
  for (const section of requiredSections) {
    if ((itemCountBySection.get(section) ?? 0) === 0) {
      throw new Error(`加固清单分组没有名称：${section}`);
    }
  }
  if (!Number.isSafeInteger(minimumItems) || minimumItems < 1 || itemCount < minimumItems) {
    throw new Error(`加固清单名称数量 ${itemCount} 低于最低基线 ${minimumItems}`);
  }

  return Object.freeze({ sections: sections.length, items: itemCount });
}

async function main() {
  const projectRoot = resolve(import.meta.dirname, "..");
  const checklistPath = resolve(projectRoot, "docs/full-stack-hardening-checklist.md");
  const source = await readFile(checklistPath, "utf8");
  const result = validateHardeningChecklist(source);
  const readme = await readFile(resolve(projectRoot, "README.md"), "utf8");
  if (!readme.includes("[前后端持续优化加固清单](docs/full-stack-hardening-checklist.md)")) {
    throw new Error("README 未链接前后端持续优化加固清单");
  }
  console.log(`加固清单契约通过：${result.sections} 个分组，${result.items} 个仅名称条目。`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "加固清单校验失败");
    process.exitCode = 1;
  });
}
