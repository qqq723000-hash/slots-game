#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;

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
  ["cluster/chart/templates/worker-deployment.yaml", ["config", "helm"]],
  ["dockerfiles/cluster/Dockerfile.services", ["config", "dockerfile"]],
  ["dockerfiles/local-services/Dockerfile.services", ["config", "dockerfile"]],
  ["dockerfiles/local-web/Dockerfile.web", ["config", "dockerfile"]],
  ["dockerfiles/root/Dockerfile", ["config", "dockerfile"]],
  ["dockerfiles/web/Dockerfile", ["config", "dockerfile"]],
]);

const expectedTerraformResultTargets = new Map([
  [".", ["config", "terraform"]],
  ["../../modules/archive/main.tf", ["config", "terraform"]],
  ["../../modules/web-edge/main.tf", ["config", "terraform"]],
]);

const expectedTerraformReports = [
  "trivy-terraform-dev.json",
  "trivy-terraform-staging.json",
  "trivy-terraform-prod-primary.json",
  "trivy-terraform-prod-dr.json",
];

const requiredTerraformEnvironmentSources = [
  "terraform/environments/dev/main.tf",
  "terraform/environments/staging/main.tf",
  "terraform/environments/prod-primary/main.tf",
  "terraform/environments/prod-dr/main.tf",
];

const requiredTerraformVariableInputs = [
  "terraform/environments/dev/terraform.tfvars.example",
  "terraform/environments/staging/terraform.tfvars.example",
  "terraform/environments/prod-primary/terraform.tfvars.example",
  "terraform/environments/prod-dr/terraform.tfvars.example",
];

const requiredTerraformSupportInputs = [
  "terraform/modules/web-edge/release-request.js",
  "terraform/modules/web-edge/release-response.js",
];

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

async function readTerraformInventory(filePath, inventoryName) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${inventoryName} 必须是普通文件且不能是符号链接`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_INVENTORY_BYTES) {
    fail(`${inventoryName} 大小不在允许范围内`);
  }

  const contents = await readFile(filePath, "utf8");
  if (!contents.endsWith("\n") || contents.includes("\r") || contents.includes("\0")) {
    fail(`${inventoryName} 必须是以 LF 结尾且不含 NUL/CR 的文本清单`);
  }

  const targets = contents.slice(0, -1).split("\n");
  if (targets.length === 0 || targets.length > 4096 || targets.some((target) => target.length === 0)) {
    fail(`${inventoryName} 目标数量或空行不合法`);
  }

  let previous = null;
  for (const target of targets) {
    const isTerraformSource = /^terraform\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.tf$/.test(target);
    const isReviewedVariableInput = requiredTerraformVariableInputs.includes(target);
    const isReviewedSupportInput = requiredTerraformSupportInputs.includes(target);
    if (!isTerraformSource && !isReviewedVariableInput && !isReviewedSupportInput) {
      fail(`${inventoryName} 包含非 Terraform 或未审阅扫描输入 ${target}`);
    }
    if (target.split("/").some((segment) => segment === "." || segment === "..")) {
      fail(`${inventoryName} 包含目录逃逸路径 ${target}`);
    }
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(target)) >= 0) {
      fail(`${inventoryName} 必须按字节序严格排序且不能重复`);
    }
    previous = target;
  }

  for (const requiredTarget of [
    ...requiredTerraformEnvironmentSources,
    ...requiredTerraformVariableInputs,
    ...requiredTerraformSupportInputs,
  ]) {
    if (!targets.includes(requiredTarget)) {
      fail(`${inventoryName} 缺少必需输入 ${requiredTarget}`);
    }
  }
  if (!targets.some((target) => /^terraform\/modules\/.+\.tf$/.test(target))) {
    fail(`${inventoryName} 没有 Terraform module 源文件`);
  }
  if (!targets.some((target) => /^terraform\/stacks\/.+\.tf$/.test(target))) {
    fail(`${inventoryName} 没有 Terraform stack 源文件`);
  }
  return targets;
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

if (process.argv.length !== 10) {
  fail(
    "用法：verify-trivy-source-report.mjs VULNERABILITY_REPORT CONFIGURATION_REPORT " +
      "TRACKED_TERRAFORM_INVENTORY COPIED_TERRAFORM_INVENTORY " +
      "DEV_TERRAFORM_REPORT STAGING_TERRAFORM_REPORT " +
      "PROD_PRIMARY_TERRAFORM_REPORT PROD_DR_TERRAFORM_REPORT",
  );
}

const vulnerabilityResults = await readReport(process.argv[2]);
const configurationResults = await readReport(process.argv[3]);
const trackedTerraformTargets = await readTerraformInventory(process.argv[4], "Git 跟踪 Terraform 清单");
const copiedTerraformTargets = await readTerraformInventory(process.argv[5], "隔离复制 Terraform 清单");
if (
  trackedTerraformTargets.length !== copiedTerraformTargets.length ||
  trackedTerraformTargets.some((target, index) => target !== copiedTerraformTargets[index])
) {
  fail("Git 跟踪 Terraform 清单与隔离复制清单不一致");
}
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
for (let index = 0; index < expectedTerraformReports.length; index += 1) {
  const reportPath = process.argv[index + 6];
  const expectedReportName = expectedTerraformReports[index];
  if (basename(reportPath) !== expectedReportName) {
    fail(`Terraform 环境报告顺序或文件名错误：需要 ${expectedReportName}`);
  }
  verifyTargets(
    await readReport(reportPath),
    expectedTerraformResultTargets,
    "Misconfigurations",
    `${expectedReportName} 生产配置报告`,
  );
}

process.stdout.write("Trivy 源码扫描覆盖契约通过\n");
