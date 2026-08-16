#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;

const expectedVulnerabilityTargets = new Map([
  ["slots-game/server/go.mod", ["lang-pkgs", "gomod"]],
  ["slots-game/web/package-lock.json", ["lang-pkgs", "npm"]],
]);

const expectedConfigurationTargets = new Map([
  ["cluster/chart/templates/autoscaling.yaml", ["config", "helm"]],
  ["cluster/chart/templates/ingresses.yaml", ["config", "helm"]],
  ["cluster/chart/templates/networkpolicies.yaml", ["config", "helm"]],
  ["cluster/chart/templates/poddisruptionbudgets.yaml", ["config", "helm"]],
  ["cluster/chart/templates/prometheusrule.yaml", ["config", "helm"]],
  ["cluster/chart/templates/rgs-deployment.yaml", ["config", "helm"]],
  ["cluster/chart/templates/serviceaccounts.yaml", ["config", "helm"]],
  ["cluster/chart/templates/servicemonitor.yaml", ["config", "helm"]],
  ["cluster/chart/templates/services.yaml", ["config", "helm"]],
  ["cluster/chart/templates/web-deployment.yaml", ["config", "helm"]],
  ["dockerfiles/cluster/Dockerfile.services", ["config", "dockerfile"]],
  ["dockerfiles/local-services/Dockerfile.services", ["config", "dockerfile"]],
  ["dockerfiles/local-web/Dockerfile.web", ["config", "dockerfile"]],
  ["dockerfiles/root/Dockerfile", ["config", "dockerfile"]],
  ["dockerfiles/web/Dockerfile", ["config", "dockerfile"]],
]);

function fail(message) {
  throw new Error(`Trivy 源码报告契约失败：${message}`);
}

async function readReport(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${filePath} 必须是普通文件且不能是符号链接`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_REPORT_BYTES) {
    fail(`${filePath} 大小不在允许范围内`);
  }

  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  if (parsed?.SchemaVersion !== 2 || !Array.isArray(parsed.Results)) {
    fail(`${filePath} 不是 Trivy schema v2 报告`);
  }
  return parsed.Results;
}

function verifyTargets(results, expectedTargets, findingField, reportName) {
  if (results.length !== expectedTargets.size) {
    fail(`${reportName} 目标数量错误：${results.length} != ${expectedTargets.size}`);
  }

  const seen = new Set();
  for (const result of results) {
    const target = result?.Target;
    if (typeof target !== "string" || seen.has(target)) {
      fail(`${reportName} 包含无效或重复目标`);
    }
    seen.add(target);

    const expectedIdentity = expectedTargets.get(target);
    if (!expectedIdentity) {
      fail(`${reportName} 包含未审阅目标 ${target}`);
    }
    if (result.Class !== expectedIdentity[0] || result.Type !== expectedIdentity[1]) {
      fail(`${target} 的扫描类型与契约不一致`);
    }

    const findings = result[findingField] ?? [];
    if (!Array.isArray(findings) || findings.length !== 0) {
      fail(`${target} 包含阻断级发现`);
    }
  }

  for (const target of expectedTargets.keys()) {
    if (!seen.has(target)) {
      fail(`${reportName} 缺少目标 ${target}`);
    }
  }
}

if (process.argv.length !== 4) {
  fail("用法：verify-trivy-source-report.mjs VULNERABILITY_REPORT CONFIGURATION_REPORT");
}

const vulnerabilityResults = await readReport(process.argv[2]);
const configurationResults = await readReport(process.argv[3]);
verifyTargets(
  vulnerabilityResults,
  expectedVulnerabilityTargets,
  "Vulnerabilities",
  "依赖漏洞报告",
);
verifyTargets(
  configurationResults,
  expectedConfigurationTargets,
  "Misconfigurations",
  "生产配置报告",
);

process.stdout.write("Trivy 源码扫描覆盖契约通过\n");
