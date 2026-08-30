// @ts-nocheck -- 该契约测试在 Node 中执行 release-only 构建配置校验器。 / English: @ts-nocheck -- This contract test executes a release-only build configuration validator in Node.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const validatorPath = fileURLToPath(
  new URL("../src/validateReleaseRgsBuildConfig.mjs", import.meta.url),
);
const dockerfile = readFileSync(new URL("../../deploy/web/Dockerfile", import.meta.url), "utf8");
const makefile = readFileSync(new URL("../../Makefile", import.meta.url), "utf8");

const REQUIRED_NAMES = [
  "VITE_RGS_BASE_URL",
  "VITE_RGS_BET_OPTIONS_MINOR",
  "VITE_RGS_DEFAULT_BET_MINOR",
  "VITE_RGS_HOST_ORIGIN",
] as const;

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITE_RGS_BASE_URL: "https://rgs.example/client",
    VITE_RGS_BET_OPTIONS_MINOR: "10,20,100",
    VITE_RGS_DEFAULT_BET_MINOR: "20",
    VITE_RGS_HOST_ORIGIN: "https://operator.example",
  };
}

function validate(environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [validatorPath], {
    env: environment,
    encoding: "utf8",
  });
}

describe("release RGS build configuration", () => {
  it("accepts a complete canonical non-secret release configuration", () => {
    const result = validate(validEnvironment());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it.each(REQUIRED_NAMES)("fails closed when %s is absent", (name) => {
    const environment = validEnvironment();
    delete environment[name];
    const result = validate(environment);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${name} is required`);
  });

  it.each([
    ["VITE_RGS_BASE_URL", "http://rgs.example", "must be a credential-free HTTPS URL"],
    ["VITE_RGS_BASE_URL", "https://user@rgs.example", "must be a credential-free HTTPS URL"],
    ["VITE_RGS_BET_OPTIONS_MINOR", "10,010", "canonical positive int64"],
    ["VITE_RGS_BET_OPTIONS_MINOR", "10,10", "must be unique"],
    ["VITE_RGS_BET_OPTIONS_MINOR", "0,10", "canonical positive int64"],
    ["VITE_RGS_DEFAULT_BET_MINOR", "50", "must occur in VITE_RGS_BET_OPTIONS_MINOR"],
    ["VITE_RGS_HOST_ORIGIN", "*", "must be an exact credential-free HTTPS origin"],
    ["VITE_RGS_HOST_ORIGIN", "https://operator.example/", "must be an exact credential-free HTTPS origin"],
    ["VITE_RGS_HOST_ORIGIN", "https://operator.example/path", "must be an exact credential-free HTTPS origin"],
  ])("rejects invalid %s without echoing its value", (name, value, message) => {
    const environment = validEnvironment();
    environment[name] = value;
    const result = validate(environment);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain(value);
  });

  it("declares and validates all four args only in the release configuration chain", () => {
    const releaseConfigStart = dockerfile.indexOf("FROM dependencies AS release-config-build");
    const releaseApprovalStart = dockerfile.indexOf("FROM release-config-build AS release-build");
    const conformanceStart = dockerfile.indexOf("FROM ${NGINX_IMAGE} AS config-conformance-nginx");
    const staticRuntimeStart = dockerfile.indexOf("FROM ${NGINX_IMAGE} AS static-conformance");
    const releaseStage = dockerfile.slice(releaseConfigStart, releaseApprovalStart);
    const releaseApprovalStage = dockerfile.slice(releaseApprovalStart, conformanceStart);
    const staticBuild = dockerfile.slice(
      dockerfile.indexOf("FROM dependencies AS static-conformance-build"),
      releaseConfigStart,
    );

    expect(releaseConfigStart).toBeGreaterThanOrEqual(0);
    expect(releaseApprovalStart).toBeGreaterThan(releaseConfigStart);
    expect(conformanceStart).toBeGreaterThan(releaseApprovalStart);
    expect(staticRuntimeStart).toBeGreaterThan(conformanceStart);
    for (const name of REQUIRED_NAMES) {
      expect(releaseStage).toContain(`ARG ${name}`);
      expect(staticBuild).not.toContain(name);
      expect(makefile).toContain(`${name} is required`);
      expect(makefile).toContain(`--build-arg ${name}=\"$\${${name}}\"`);
    }
    const buildCommand = "npm --ignore-scripts run build";
    expect(releaseStage).toContain("node ./src/validateReleaseRgsBuildConfig.mjs");
    expect(releaseStage).toContain(buildCommand);
    expect(releaseStage.indexOf("node ./src/validateReleaseRgsBuildConfig.mjs"))
      .toBeLessThan(releaseStage.indexOf(buildCommand));
    expect(releaseStage.indexOf(buildCommand))
      .toBeLessThan(releaseStage.indexOf("finalize-production-assets.mjs --check"));
    expect(releaseApprovalStage.indexOf("finalize-production-assets.mjs --check"))
      .toBeLessThan(releaseApprovalStage.indexOf("verify-release-asset-approval.mjs"));
    expect(releaseApprovalStage).toContain("verify-release-asset-approval.mjs");
    expect(releaseApprovalStage).not.toMatch(/\bnpm\b/u);
  });
});
