import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";

import {
  assertNoIgnoredBuildInputs,
  assertNoViteEnvironmentFiles,
  LocalSourceIdentityError,
  resolveLocalSourceIdentity,
} from "./resolve-source-identity.mjs";

const temporaryRoots = [];

function command(root, arguments_) {
  const result = spawnSync("git", ["-C", root, ...arguments_], {
    encoding: "utf8",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
      PATH: process.env.PATH,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function makeRepository() {
  const root = mkdtempSync(resolve(tmpdir(), "slots-source-identity-"));
  temporaryRoots.push(root);
  mkdirSync(resolve(root, "server"));
  mkdirSync(resolve(root, "web", "public"), { recursive: true });
  mkdirSync(resolve(root, "web", "src"), { recursive: true });
  writeFileSync(resolve(root, ".gitignore"), [
    ".env",
    ".env.*",
    "*.key",
    "server/bin/",
    "server/coverage.out",
    "web/coverage/",
    "web/dist/",
    "web/node_modules/",
    "web/release-nginx.conf",
    "",
  ].join("\n"), "utf8");
  writeFileSync(resolve(root, "tracked.txt"), "canonical\n", "utf8");
  writeFileSync(resolve(root, "server", "main.go"), "package main\n", "utf8");
  writeFileSync(resolve(root, "web", "public", "tracked.txt"), "public\n", "utf8");
  writeFileSync(resolve(root, "web", "src", "main.ts"), "export {};\n", "utf8");
  command(root, ["init", "--quiet"]);
  command(root, ["config", "user.email", "local-source@example.invalid"]);
  command(root, ["config", "user.name", "Local Source Test"]);
  command(root, ["add", "."]);
  command(root, ["commit", "--quiet", "-m", "initial"]);
  return {
    root,
    head: command(root, ["rev-parse", "--verify", "HEAD^{commit}"]).slice(0, -1),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("resolves one clean HEAD and accepts only an exact override assertion", () => {
  const fixture = makeRepository();
  assert.equal(resolveLocalSourceIdentity(fixture.root, { PATH: process.env.PATH }), fixture.head);
  assert.equal(resolveLocalSourceIdentity(fixture.root, {
    PATH: process.env.PATH,
    LOCAL_PRODUCTION_IMAGE_REVISION: fixture.head,
  }), fixture.head);

  for (const override of [
    "",
    "f".repeat(40),
    `${fixture.head}\n`,
    `${fixture.head}\n${fixture.head}`,
    ` ${fixture.head}`,
  ]) {
    assert.throws(
      () => resolveLocalSourceIdentity(fixture.root, {
        PATH: process.env.PATH,
        LOCAL_PRODUCTION_IMAGE_REVISION: override,
      }),
      /must exactly match Git HEAD\^\{commit\}/u,
    );
  }
});

test("fails closed on dirty tracked and untracked project bytes", () => {
  const tracked = makeRepository();
  writeFileSync(resolve(tracked.root, "tracked.txt"), "changed\n", "utf8");
  assert.throws(
    () => resolveLocalSourceIdentity(tracked.root, { PATH: process.env.PATH }),
    /worktree must be clean/u,
  );

  const untracked = makeRepository();
  writeFileSync(resolve(untracked.root, "untracked.txt"), "changed\n", "utf8");
  assert.throws(
    () => resolveLocalSourceIdentity(untracked.root, { PATH: process.env.PATH }),
    /worktree must be clean/u,
  );
});

test("rejects ignored Docker and Vite inputs outside deterministic generated paths", async (t) => {
  for (const path of [
    "server/bin/rgs-server",
    "server/coverage.out",
    "web/public/injected.key",
    "web/src/injected.key",
    "web/coverage/report.json",
  ]) {
    await t.test(path, () => {
      const fixture = makeRepository();
      const absolutePath = resolve(fixture.root, path);
      mkdirSync(resolve(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, "ignored build input\n", "utf8");
      assert.throws(
        () => resolveLocalSourceIdentity(fixture.root, {}),
        /forbidden ignored build input/u,
      );
    });
  }
});

test("allows only real deterministic npm, dist, and rendered Nginx paths", () => {
  const fixture = makeRepository();
  mkdirSync(resolve(fixture.root, "web", "node_modules", "package"), { recursive: true });
  mkdirSync(resolve(fixture.root, "web", "dist", "assets"), { recursive: true });
  writeFileSync(resolve(fixture.root, "web", "node_modules", "package", "index.js"), "module.exports = 1;\n", "utf8");
  writeFileSync(resolve(fixture.root, "web", "dist", "assets", "app.js"), "export {};\n", "utf8");
  writeFileSync(resolve(fixture.root, "web", "release-nginx.conf"), "server {}\n", "utf8");
  assert.equal(resolveLocalSourceIdentity(fixture.root, {}), fixture.head);

  const linked = makeRepository();
  symlinkSync(resolve(linked.root, "outside"), resolve(linked.root, "web", "node_modules"));
  assert.throws(
    () => assertNoIgnoredBuildInputs(linked.root),
    /node_modules must be a real directory/u,
  );
});

test("rejects every Vite .env* entry even when Git ignores it or it is a symlink", async (t) => {
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    ".environment",
    ".ENV",
    ".EnV.local",
  ]) {
    await t.test(name, () => {
      const fixture = makeRepository();
      writeFileSync(resolve(fixture.root, "web", name), "VITE_UNTRUSTED=1\n", "utf8");
      assert.throws(
        () => resolveLocalSourceIdentity(fixture.root, { PATH: process.env.PATH }),
        /forbidden Vite \.env\* entry/u,
      );
    });
  }

  await t.test("symbolic link", () => {
    const fixture = makeRepository();
    symlinkSync(resolve(fixture.root, "missing-secret"), resolve(fixture.root, "web", ".EnV.local"));
    assert.throws(
      () => assertNoViteEnvironmentFiles(fixture.root),
      /forbidden Vite \.env\* entry/u,
    );
  });
});

test("rejects npm project configuration files including case aliases and symlinks", async (t) => {
  for (const name of [".npmrc", ".NPMRC"]) {
    await t.test(name, () => {
      const fixture = makeRepository();
      writeFileSync(resolve(fixture.root, "web", name), "node-options=--import=./preload.mjs\n", "utf8");
      assert.throws(
        () => resolveLocalSourceIdentity(fixture.root, {}),
        /forbidden npm project configuration/u,
      );
    });
  }

  await t.test("symbolic link", () => {
    const fixture = makeRepository();
    symlinkSync(resolve(fixture.root, "missing-npmrc"), resolve(fixture.root, "web", ".NPMRC"));
    assert.throws(
      () => assertNoViteEnvironmentFiles(fixture.root),
      /forbidden npm project configuration/u,
    );
  });
});

test("rejects Git failures, malformed multi-value output, and a moving HEAD", () => {
  const fixture = makeRepository();
  const head = `${fixture.head}\n`;
  const success = (stdout) => ({ status: 0, signal: null, stdout });

  assert.throws(
    () => resolveLocalSourceIdentity(fixture.root, {}, () => ({ status: 128, stdout: "" })),
    /Git HEAD resolution failed/u,
  );

  let statusFailureCall = 0;
  assert.throws(() => resolveLocalSourceIdentity(fixture.root, {}, () => {
    statusFailureCall += 1;
    return statusFailureCall === 1 ? success(head) : { status: 128, stdout: "" };
  }), /Git worktree status failed/u);

  assert.throws(
    () => resolveLocalSourceIdentity(fixture.root, {}, () => success(`${head}${head}`)),
    /exactly one complete lowercase commit digest/u,
  );

  let movingHeadCall = 0;
  assert.throws(() => resolveLocalSourceIdentity(fixture.root, {}, () => {
    movingHeadCall += 1;
    if (movingHeadCall === 1) return success(head);
    if (movingHeadCall === 2) return success("");
    if (movingHeadCall === 3) return success("");
    return success(`${"f".repeat(40)}\n`);
  }), /Git HEAD changed/u);

  let ignoredFailureCall = 0;
  assert.throws(() => resolveLocalSourceIdentity(fixture.root, {}, () => {
    ignoredFailureCall += 1;
    if (ignoredFailureCall === 1) return success(head);
    if (ignoredFailureCall === 2) return success("");
    return { status: 128, stdout: "" };
  }), /Git ignored build input inspection failed/u);

  assert.throws(
    () => resolveLocalSourceIdentity(fixture.root, {}, () => ({
      error: new Error("spawn failed"),
      status: null,
      stdout: "",
    })),
    (error) => error instanceof LocalSourceIdentityError,
  );
});

test("uses the fixed Git executable and does not inherit Git or PATH controls", () => {
  const fixture = makeRepository();
  const outputs = [`${fixture.head}\n`, "", "", `${fixture.head}\n`];
  const calls = [];
  assert.equal(resolveLocalSourceIdentity(fixture.root, {
    GIT_DIR: "/untrusted/repository",
    LOCAL_PRODUCTION_IMAGE_REVISION: fixture.head,
    PATH: "/untrusted/bin",
  }, (commandPath, arguments_, options) => {
    calls.push({ commandPath, arguments_, options });
    return { status: 0, signal: null, stdout: outputs.shift() };
  }), fixture.head);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.commandPath, "/usr/bin/git");
    assert.equal(call.options.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(Object.hasOwn(call.options.env, "GIT_DIR"), false);
    assert.deepEqual(call.arguments_.slice(0, 6), [
      "-C",
      resolve(fixture.root),
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
    ]);
  }
});
