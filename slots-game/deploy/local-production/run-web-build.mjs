#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePublicReleaseIdentity } from "../../web/scripts/release-manifest.mjs";
import {
  assertNoIgnoredBuildInputs,
  assertNoViteEnvironmentFiles,
} from "./resolve-source-identity.mjs";

export class LocalWebBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalWebBuildError";
  }
}

function fail(message) {
  throw new LocalWebBuildError(message);
}

function executable(path, label) {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    fail(`${label} is not executable`);
  }
}

function runNpm(npmPath, arguments_, webRoot, environment, runner, label) {
  const result = runner(npmPath, arguments_, {
    cwd: webRoot,
    env: environment,
    stdio: "inherit",
  });
  if (!result || result.error || result.signal || result.status !== 0) fail(`${label} failed`);
}

function assertEmptyPrivateNpmConfiguration(path, label) {
  let information;
  try {
    information = lstatSync(path);
  } catch {
    fail(`${label} cannot be inspected`);
  }
  if (!information.isFile() || information.isSymbolicLink()
      || (information.mode & 0o777) !== 0o600 || information.size !== 0) {
    fail(`${label} must remain an empty private file`);
  }
}

function removeTemporaryNpmConfigurations(configuration, requireFiles) {
  let cleanupFailed = false;
  for (const path of [configuration.userConfig, configuration.globalConfig]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (requireFiles || error?.code !== "ENOENT") cleanupFailed = true;
    }
  }
  try {
    rmdirSync(configuration.directory);
  } catch {
    cleanupFailed = true;
  }
  return !cleanupFailed;
}

function createTemporaryNpmConfigurations() {
  const directory = mkdtempSync(resolve(tmpdir(), "slots-local-production-npm-"));
  const configuration = {
    directory,
    globalConfig: resolve(directory, "global.npmrc"),
    userConfig: resolve(directory, "user.npmrc"),
  };
  try {
    for (const path of [configuration.userConfig, configuration.globalConfig]) {
      writeFileSync(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
    }
    assertEmptyPrivateNpmConfiguration(configuration.userConfig, "temporary npm user configuration");
    assertEmptyPrivateNpmConfiguration(configuration.globalConfig, "temporary npm global configuration");
    return configuration;
  } catch (error) {
    removeTemporaryNpmConfigurations(configuration, false);
    throw error;
  }
}

/**
 * 不继承调用进程环境。只有下面列出的发布身份和 RGS 浏览器配置可进入 Vite；
// English: The calling process environment is not inherited. Only the publishing identities and RGS browser
// configurations listed below can enter Vite; NODE_OPTIONS, unexpected VITE_*, npm_config_*, proxy and user
// shell variables are not propagated.
 * NODE_OPTIONS、非预期 VITE_*、npm_config_*、代理和用户 shell 变量均不会传播。
 */
export function localProductionWebBuildEnvironment(nodeRoot, version, revision) {
  const identity = normalizePublicReleaseIdentity({ version, revision, requireRevision: true });
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: `${resolve(nodeRoot, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TZ: "UTC",
    VITE_OPERATOR_RETURN_URL: "/operator/",
    VITE_RGS_BASE_URL: "https://rgs.localhost:8443",
    VITE_RGS_BET_OPTIONS_MINOR: "10,20,50,100,200,300,400,600,1000,2000,5000,10000",
    VITE_RGS_DEFAULT_BET_MINOR: "100",
    VITE_RGS_HOST_ORIGIN: "https://slots.localhost:8443",
    WEB_RELEASE_REQUIRE_IDENTITY: "1",
    WEB_RELEASE_REVISION: identity.revision,
    WEB_RELEASE_VERSION: identity.version,
  };
}

export function runLocalProductionWebBuild({
  projectRoot,
  nodeRoot,
  version,
  revision,
  runner = spawnSync,
  gitRunner = spawnSync,
}) {
  if ([projectRoot, nodeRoot, version, revision].some((value) => (
    typeof value !== "string" || value.trim() === ""
  ))) {
    fail("project root, Node root, version, and revision are required");
  }
  const resolvedProjectRoot = resolve(projectRoot);
  const resolvedNodeRoot = resolve(nodeRoot);
  const webRoot = resolve(resolvedProjectRoot, "web");
  const npmPath = resolve(resolvedNodeRoot, "bin", "npm");
  executable(resolve(resolvedNodeRoot, "bin", "node"), "approved Node.js");
  executable(npmPath, "approved npm");
  const environment = localProductionWebBuildEnvironment(resolvedNodeRoot, version, revision);

  assertNoViteEnvironmentFiles(resolvedProjectRoot);
  assertNoIgnoredBuildInputs(resolvedProjectRoot, gitRunner);
  const configuration = createTemporaryNpmConfigurations();
  try {
    const npmConfigurationArguments = [
      `--userconfig=${configuration.userConfig}`,
      `--globalconfig=${configuration.globalConfig}`,
    ];
    assertEmptyPrivateNpmConfiguration(configuration.userConfig, "temporary npm user configuration");
    assertEmptyPrivateNpmConfiguration(configuration.globalConfig, "temporary npm global configuration");
    runNpm(
      npmPath,
      [...npmConfigurationArguments, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      webRoot,
      environment,
      runner,
      "npm ci",
    );
    assertEmptyPrivateNpmConfiguration(configuration.userConfig, "temporary npm user configuration");
    assertEmptyPrivateNpmConfiguration(configuration.globalConfig, "temporary npm global configuration");
    assertNoViteEnvironmentFiles(resolvedProjectRoot);
    assertNoIgnoredBuildInputs(resolvedProjectRoot, gitRunner);
    runNpm(
      npmPath,
      [...npmConfigurationArguments, "run", "build"],
      webRoot,
      environment,
      runner,
      "Web build",
    );
    assertEmptyPrivateNpmConfiguration(configuration.userConfig, "temporary npm user configuration");
    assertEmptyPrivateNpmConfiguration(configuration.globalConfig, "temporary npm global configuration");
    assertNoViteEnvironmentFiles(resolvedProjectRoot);
    assertNoIgnoredBuildInputs(resolvedProjectRoot, gitRunner);
  } finally {
    if (!removeTemporaryNpmConfigurations(configuration, true)) {
      fail("temporary npm configuration cleanup failed");
    }
  }
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  if (process.argv.length !== 6) {
    throw new Error("usage: run-web-build.mjs PROJECT_ROOT NODE_ROOT VERSION REVISION");
  }
  runLocalProductionWebBuild({
    projectRoot: process.argv[2],
    nodeRoot: process.argv[3],
    version: process.argv[4],
    revision: process.argv[5],
  });
}
