#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REVISION_OVERRIDE = "LOCAL_PRODUCTION_IMAGE_REVISION";
const REVISION_OUTPUT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/u;
const GIT_PATH = "/usr/bin/git";

export class LocalSourceIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalSourceIdentityError";
  }
}

function fail(message) {
  throw new LocalSourceIdentityError(message);
}

function realDirectory(path, label) {
  let information;
  try {
    information = lstatSync(path);
  } catch {
    fail(`${label} cannot be inspected`);
  }
  if (!information.isDirectory() || information.isSymbolicLink()) {
    fail(`${label} must be a real directory`);
  }
}

function optionalGeneratedInput(path, kind, label) {
  let information;
  try {
    information = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(`${label} cannot be inspected`);
  }
  const matches = kind === "directory" ? information.isDirectory() : information.isFile();
  if (!matches || information.isSymbolicLink()) {
    fail(`${label} must be a real ${kind}`);
  }
}

/**
 * Vite 会在项目根目录自动读取 .env、.env.local、.env.[mode] 等文件。它们通常
 * 被 Git 忽略，因此不能只依赖工作区 clean 检查。任何 .env* 条目（包括符号链接）
// English: Vite will automatically read .env, .env.local, .env.[mode] and other files in the project root
// directory. They usually Ignored by Git, so cannot rely solely on workspace clean checks. Any .env* entry
// (including symlinks) All must be explicitly exited before the native candidate can be built.
 * 都必须在本机正式候选构建前显式退出。
 */
export function assertNoViteEnvironmentFiles(projectRoot) {
  const webRoot = resolve(projectRoot, "web");
  realDirectory(webRoot, "Web project root");
  let entries;
  try {
    entries = readdirSync(webRoot, { withFileTypes: true });
  } catch {
    fail("Web project root cannot be read");
  }
  const forbidden = entries.map((entry) => entry.name).filter((name) => (
    name.slice(0, 4).toLowerCase() === ".env"
  ));
  if (forbidden.length > 0) {
    fail("Web project root contains a forbidden Vite .env* entry");
  }
  if (entries.some((entry) => entry.name.toLowerCase() === ".npmrc")) {
    fail("Web project root contains a forbidden npm project configuration");
  }
}

/**
 * Git clean 不报告 ignored 文件，但 Dockerfile.services 会把 server/** 纳入上下文，
 * Vite 也会读取 web 下的源码与 public 文件。仅允许 npm ci、Vite 和 Nginx 渲染器会
// English: Git clean does not report ignored files, but Dockerfile.services will include server/** into the
// context, Vite will also read source code and public files on the web. Only npm ci, Vite and Nginx renderers
// are allowed Three paths for deterministic reconstruction; remaining ignored server/web bytes will fail and
// close.
 * 确定性重建的三个路径；其余 ignored server/web 字节一律失败关闭。
 */
export function assertNoIgnoredBuildInputs(projectRoot, runner = spawnSync) {
  const resolvedProjectRoot = resolve(projectRoot);
  realDirectory(resolvedProjectRoot, "project root");
  optionalGeneratedInput(resolve(resolvedProjectRoot, "web", "node_modules"), "directory", "node_modules");
  optionalGeneratedInput(resolve(resolvedProjectRoot, "web", "dist"), "directory", "Web dist");
  optionalGeneratedInput(
    resolve(resolvedProjectRoot, "web", "release-nginx.conf"),
    "file",
    "rendered Nginx configuration",
  );

  const output = runGit(
    resolvedProjectRoot,
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      "server",
      "web",
      ":(exclude)web/node_modules",
      ":(exclude)web/node_modules/**",
      ":(exclude)web/dist",
      ":(exclude)web/dist/**",
      ":(exclude)web/release-nginx.conf",
    ],
    "Git ignored build input inspection",
    runner,
  );
  if (output !== "" && !output.endsWith("\0")) {
    fail("Git ignored build input inspection returned invalid output");
  }
  const entries = output === "" ? [] : output.slice(0, -1).split("\0");
  for (const path of entries) {
    if (path === "" || path.startsWith("/") || path.includes("\\")
        || /[\u0000-\u001f\u007f]/u.test(path)) {
      fail("Git ignored build input inspection returned an invalid path");
    }
    fail("project contains a forbidden ignored build input");
  }
}

function gitEnvironment() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

function runGit(projectRoot, arguments_, label, runner) {
  const result = runner(GIT_PATH, [
    "-C",
    projectRoot,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    ...arguments_,
  ], {
    encoding: "utf8",
    env: gitEnvironment(),
  });
  if (!result || result.error || result.signal || result.status !== 0) {
    fail(`${label} failed`);
  }
  if (typeof result.stdout !== "string") fail(`${label} returned invalid output`);
  return result.stdout;
}

function readHead(projectRoot, runner) {
  const output = runGit(
    projectRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "Git HEAD resolution",
    runner,
  );
  if (!REVISION_OUTPUT_PATTERN.test(output)) {
    fail("Git HEAD resolution must return exactly one complete lowercase commit digest");
  }
  return { output, revision: output.slice(0, -1) };
}

/**
 * 固定本机生产候选的唯一源码身份。显式 override 只是对 HEAD 的逐字节断言，不能
// English: Fixed unique source identity for native artifactsion candidates. Explicit override is only a
// byte-by-byte assertion of HEAD and cannot Rewrite the identity; failure in any step of HEAD, status or review
// will result in immediate failure and shutdown.
 * 改写身份；HEAD、status 或复核任一步骤失败都会立即失败关闭。
 */
export function resolveLocalSourceIdentity(
  projectRoot,
  environment = process.env,
  runner = spawnSync,
) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    fail("project root is required");
  }
  const resolvedProjectRoot = resolve(projectRoot);
  realDirectory(resolvedProjectRoot, "project root");
  assertNoViteEnvironmentFiles(resolvedProjectRoot);

  const firstHead = readHead(resolvedProjectRoot, runner);
  if (Object.hasOwn(environment, REVISION_OVERRIDE)
      && environment[REVISION_OVERRIDE] !== firstHead.revision) {
    fail(`${REVISION_OVERRIDE} must exactly match Git HEAD^{commit}`);
  }

  const status = runGit(
    resolvedProjectRoot,
    ["status", "--porcelain=v1", "--untracked-files=normal", "--", "."],
    "Git worktree status",
    runner,
  );
  if (status !== "") fail("project worktree must be clean");
  assertNoIgnoredBuildInputs(resolvedProjectRoot, runner);

  // 被忽略的 .env* 可能在 status 之后出现；HEAD 二次读取同时关闭 ref/status 竞态。
  // English: The ignored .env* may appear after status; HEAD is read twice and the ref/status race condition is
  // closed at the same time.
  assertNoViteEnvironmentFiles(resolvedProjectRoot);
  const secondHead = readHead(resolvedProjectRoot, runner);
  if (secondHead.output !== firstHead.output) fail("Git HEAD changed while source identity was resolved");
  return firstHead.revision;
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  if (process.argv.length !== 3) {
    throw new Error("usage: resolve-source-identity.mjs PROJECT_ROOT");
  }
  process.stdout.write(`${resolveLocalSourceIdentity(process.argv[2])}\n`);
}
