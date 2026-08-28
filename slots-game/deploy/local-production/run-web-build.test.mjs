import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test, { afterEach } from "node:test";

import {
  localProductionWebBuildEnvironment,
  LocalWebBuildError,
  runLocalProductionWebBuild,
} from "./run-web-build.mjs";

const temporaryRoots = [];
const revision = "a".repeat(40);
const cleanGitRunner = () => ({ status: 0, signal: null, stdout: "" });

function makeFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "slots-web-build-"));
  temporaryRoots.push(root);
  const nodeRoot = resolve(root, "node");
  mkdirSync(resolve(root, "web"));
  mkdirSync(resolve(nodeRoot, "bin"), { recursive: true });
  for (const executable of ["node", "npm"]) {
    const path = resolve(nodeRoot, "bin", executable);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o700 });
  }
  return { root, nodeRoot };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("constructs one explicit production environment without ambient build controls", () => {
  const environment = localProductionWebBuildEnvironment("/approved/node", "1.3.0", revision);
  assert.deepEqual(Object.keys(environment).sort(), [
    "LANG",
    "LC_ALL",
    "PATH",
    "TZ",
    "VITE_OPERATOR_RETURN_URL",
    "VITE_RGS_BASE_URL",
    "VITE_RGS_BET_OPTIONS_MINOR",
    "VITE_RGS_DEFAULT_BET_MINOR",
    "VITE_RGS_HOST_ORIGIN",
    "WEB_RELEASE_REQUIRE_IDENTITY",
    "WEB_RELEASE_REVISION",
    "WEB_RELEASE_VERSION",
  ]);
  assert.equal(environment.PATH, "/approved/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(environment.WEB_RELEASE_VERSION, "1.3.0");
  assert.equal(environment.WEB_RELEASE_REVISION, revision);
  for (const forbidden of ["NODE_OPTIONS", "VITE_UNREVIEWED", "npm_config_registry", "HOME"]) {
    assert.equal(Object.hasOwn(environment, forbidden), false);
  }
});

test("runs npm ci and build with the same exact allowlisted environment", () => {
  const fixture = makeFixture();
  const calls = [];
  let gitChecks = 0;
  runLocalProductionWebBuild({
    projectRoot: fixture.root,
    nodeRoot: fixture.nodeRoot,
    version: "1.3.0",
    revision,
    gitRunner() {
      gitChecks += 1;
      return cleanGitRunner();
    },
    runner(command, arguments_, options) {
      calls.push({ command, arguments_, options });
      return { status: 0, signal: null };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(gitChecks, 3);
  const userConfiguration = calls[0].arguments_[0].slice("--userconfig=".length);
  const globalConfiguration = calls[0].arguments_[1].slice("--globalconfig=".length);
  assert.notEqual(userConfiguration, globalConfiguration);
  assert.equal(dirname(userConfiguration), dirname(globalConfiguration));
  assert.equal(existsSync(userConfiguration), false);
  assert.equal(existsSync(globalConfiguration), false);
  assert.equal(existsSync(dirname(userConfiguration)), false);
  assert.deepEqual(calls[0].arguments_.slice(2), [
    "ci", "--ignore-scripts", "--no-audit", "--no-fund",
  ]);
  assert.deepEqual(calls[1].arguments_.slice(2), ["run", "build"]);
  assert.deepEqual(calls[1].arguments_.slice(0, 2), calls[0].arguments_.slice(0, 2));
  for (const call of calls) {
    assert.equal(call.command, resolve(fixture.nodeRoot, "bin", "npm"));
    assert.equal(call.options.cwd, resolve(fixture.root, "web"));
    assert.equal(call.options.stdio, "inherit");
    assert.deepEqual(
      call.options.env,
      localProductionWebBuildEnvironment(fixture.nodeRoot, "1.3.0", revision),
    );
  }
});

test("uses two empty private npm configurations and removes them after failure", () => {
  const fixture = makeFixture();
  const configurationPaths = [];
  assert.throws(() => runLocalProductionWebBuild({
    projectRoot: fixture.root,
    nodeRoot: fixture.nodeRoot,
    version: "1.3.0",
    revision,
    gitRunner: cleanGitRunner,
    runner(_command, arguments_) {
      const paths = arguments_.slice(0, 2).map((argument) => argument.slice(argument.indexOf("=") + 1));
      configurationPaths.push(...paths);
      assert.notEqual(paths[0], paths[1]);
      for (const path of paths) {
        assert.equal(readFileSync(path, "utf8"), "");
        assert.equal(statSync(path).mode & 0o777, 0o600);
      }
      return { status: 9, signal: null };
    },
  }), /npm ci failed/u);
  assert.equal(configurationPaths.length, 2);
  for (const path of configurationPaths) assert.equal(existsSync(path), false);
  assert.equal(existsSync(dirname(configurationPaths[0])), false);
});

test("fails before Vite if npm changes either isolated configuration", () => {
  const fixture = makeFixture();
  let calls = 0;
  let userConfiguration;
  assert.throws(() => runLocalProductionWebBuild({
    projectRoot: fixture.root,
    nodeRoot: fixture.nodeRoot,
    version: "1.3.0",
    revision,
    gitRunner: cleanGitRunner,
    runner(_command, arguments_) {
      calls += 1;
      userConfiguration = arguments_[0].slice("--userconfig=".length);
      writeFileSync(userConfiguration, "registry=https://untrusted.invalid/\n", "utf8");
      return { status: 0, signal: null };
    },
  }), /temporary npm user configuration must remain an empty private file/u);
  assert.equal(calls, 1);
  assert.equal(existsSync(userConfiguration), false);
});

test("rechecks ignored build inputs after install before invoking Vite", () => {
  const fixture = makeFixture();
  let npmCalls = 0;
  let gitChecks = 0;
  assert.throws(() => runLocalProductionWebBuild({
    projectRoot: fixture.root,
    nodeRoot: fixture.nodeRoot,
    version: "1.3.0",
    revision,
    runner() {
      npmCalls += 1;
      return { status: 0, signal: null };
    },
    gitRunner() {
      gitChecks += 1;
      return {
        status: 0,
        signal: null,
        stdout: gitChecks === 1 ? "" : "web/src/injected.key\0",
      };
    },
  }), /forbidden ignored build input/u);
  assert.equal(npmCalls, 1);
  assert.equal(gitChecks, 2);
});

test("rechecks forbidden .env* bytes between install and build", () => {
  const fixture = makeFixture();
  let calls = 0;
  assert.throws(() => runLocalProductionWebBuild({
    projectRoot: fixture.root,
    nodeRoot: fixture.nodeRoot,
    version: "1.3.0",
    revision,
    gitRunner: cleanGitRunner,
    runner() {
      calls += 1;
      writeFileSync(resolve(fixture.root, "web", ".env.production"), "VITE_HIDDEN=1\n", "utf8");
      return { status: 0, signal: null };
    },
  }), /forbidden Vite \.env\* entry/u);
  assert.equal(calls, 1);
});

test("fails closed on spawn errors, signals, and non-zero npm status", () => {
  for (const result of [
    { error: new Error("spawn failed"), status: null },
    { signal: "SIGTERM", status: null },
    { signal: null, status: 7 },
  ]) {
    const fixture = makeFixture();
    assert.throws(
      () => runLocalProductionWebBuild({
        projectRoot: fixture.root,
        nodeRoot: fixture.nodeRoot,
        version: "1.3.0",
        revision,
        gitRunner: cleanGitRunner,
        runner: () => result,
      }),
      (error) => error instanceof LocalWebBuildError && /npm ci failed/u.test(error.message),
    );
  }
});

test("rejects an anonymous or malformed release identity before invoking npm", () => {
  const fixture = makeFixture();
  let called = false;
  for (const invalidRevision of ["unavailable", "abcdef0", `${revision}\n`]) {
    assert.throws(() => runLocalProductionWebBuild({
      projectRoot: fixture.root,
      nodeRoot: fixture.nodeRoot,
      version: "1.3.0",
      revision: invalidRevision,
      gitRunner: cleanGitRunner,
      runner() {
        called = true;
        return { status: 0 };
      },
    }), /complete lowercase Git commit/u);
  }
  assert.equal(called, false);
});
