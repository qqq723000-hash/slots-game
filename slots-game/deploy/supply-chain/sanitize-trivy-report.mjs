#!/usr/bin/env node

// Trivy 会遮蔽已命中的 Match，但 Code 上下文仍可能包含邻近业务值。审计制品只需要
// 规则、位置和严重级别，因此统一删除原文/上下文，避免 always-upload 泄露凭据片段。
import fs from "node:fs";
import path from "node:path";

const [reportPath] = process.argv.slice(2);
if (!reportPath || !path.isAbsolute(reportPath)) {
  throw new Error("absolute Trivy report path is required");
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const results = Array.isArray(report) ? report : report.Results;
if (!Array.isArray(results)) {
  throw new Error("Trivy report has no Results array");
}

for (const result of results) {
  if (!Array.isArray(result.Secrets)) continue;
  for (const finding of result.Secrets) {
    delete finding.Code;
    delete finding.Match;
  }
}

const temporaryPath = `${reportPath}.sanitized`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPath, reportPath);
