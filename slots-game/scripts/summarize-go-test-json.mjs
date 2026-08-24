#!/usr/bin/env node

import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`Go 测试摘要失败：${message}\n`);
  process.exit(1);
}

const [eventPath, allowlistPath] = process.argv.slice(2);
if (!eventPath || !allowlistPath) {
  fail("需要 go test -json 日志和 skip allowlist 路径");
}

const terminalByTest = new Map();
for (const [index, line] of readFileSync(eventPath, "utf8").split(/\r?\n/u).entries()) {
  if (!line) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    fail(`第 ${index + 1} 行不是有效 JSON`);
  }
  if (
    typeof event.Package !== "string" ||
    typeof event.Test !== "string" ||
    !["pass", "skip", "fail"].includes(event.Action)
  ) {
    continue;
  }
  terminalByTest.set(`${event.Package}\t${event.Test}`, event.Action);
}

const testKeys = [...terminalByTest.keys()];
const leafTests = testKeys.filter(
  (key) => !testKeys.some((candidate) => candidate.startsWith(`${key}/`)),
);
const passed = leafTests.filter((key) => terminalByTest.get(key) === "pass");
const skipped = leafTests.filter((key) => terminalByTest.get(key) === "skip").sort();
const failed = leafTests.filter((key) => terminalByTest.get(key) === "fail");
if (failed.length > 0) {
  fail(`发现 ${failed.length} 个失败的叶子测试`);
}
if (passed.length === 0) {
  fail("没有发现通过的叶子测试");
}

const expectedSkips = readFileSync(allowlistPath, "utf8")
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .sort();
if (new Set(expectedSkips).size !== expectedSkips.length) {
  fail("skip allowlist 包含重复项");
}

const missing = expectedSkips.filter((key) => !skipped.includes(key));
const unexpected = skipped.filter((key) => !expectedSkips.includes(key));
if (missing.length > 0 || unexpected.length > 0) {
  const details = [
    missing.length > 0 ? `未按预期跳过：${missing.join(", ")}` : "",
    unexpected.length > 0 ? `出现未批准跳过：${unexpected.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("；");
  fail(details);
}

process.stdout.write(
  `${JSON.stringify({
    leaf_passed: passed.length,
    leaf_skipped: skipped.length,
    skip_allowlist_verified: true,
  })}\n`,
);
