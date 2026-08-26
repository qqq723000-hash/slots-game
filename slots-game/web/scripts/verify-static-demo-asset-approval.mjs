import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReleaseAssetApprovalError, verifyReleaseAssetApproval } from "./verify-release-asset-approval.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(scriptPath), "..");

/**
 * 公开 Demo 分发与正式 Web 包相同的受保护素材族，因此复用同一套规范化精确哈希
 * 审批结构。审批仍来自仓库外部；本包装器既不生成审批，也不降低审批强度。
 */
export function verifyStaticDemoAssetApproval({
  manifestPath = resolve(webRoot, "dist-demo", "release-manifest.json"),
  approvalPath = process.env.STATIC_DEMO_ASSET_APPROVAL_FILE ?? "",
  now = new Date(),
} = {}) {
  return verifyReleaseAssetApproval({
    manifestPath,
    approvalPath,
    now,
    requiredJurisdiction: "PUBLIC-INTERNET",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const supportedArguments = new Set(["--print-expires-at"]);
    const argumentsAfterScript = process.argv.slice(2);
    if (argumentsAfterScript.some((argument) => !supportedArguments.has(argument))) {
      throw new ReleaseAssetApprovalError("static demo approval command has an unsupported argument");
    }
    const { approvedAssets, expiresAt } = verifyStaticDemoAssetApproval();
    if (argumentsAfterScript.includes("--print-expires-at")) {
      process.stdout.write(`${expiresAt}\n`);
    } else {
      process.stdout.write(`static demo asset approval: ok (${approvedAssets} protected assets)\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected validation error";
    process.stderr.write(`static demo asset approval: ${message}\n`);
    process.exitCode = 1;
  }
}
