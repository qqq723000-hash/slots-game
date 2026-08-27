import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLocalImageVersion } from "./resolve-image-version.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(dirname(fileURLToPath(import.meta.url)), "resolve-image-version.mjs");
const repositoryVersion = readFileSync(resolve(projectRoot, "VERSION"), "utf8").slice(0, -1);
const differentVersion = repositoryVersion === "0.0.0" ? "0.0.1" : "0.0.0";

test("uses the synchronized repository version when no override exists", () => {
  assert.equal(resolveLocalImageVersion(projectRoot, {}), repositoryVersion);
});

test("accepts only an exact explicit repository-version assertion", () => {
  assert.equal(resolveLocalImageVersion(projectRoot, {
    LOCAL_PRODUCTION_IMAGE_VERSION: repositoryVersion,
  }), repositoryVersion);

  for (const invalidVersion of ["", differentVersion, ` ${repositoryVersion}`, `${repositoryVersion} `]) {
    assert.throws(
      () => resolveLocalImageVersion(projectRoot, {
        LOCAL_PRODUCTION_IMAGE_VERSION: invalidVersion,
      }),
      /LOCAL_PRODUCTION_IMAGE_VERSION must exactly match repository VERSION/u,
    );
  }
});

test("CLI emits only the canonical version and fails closed on an invalid assertion", () => {
  const defaultEnvironment = { ...process.env };
  delete defaultEnvironment.LOCAL_PRODUCTION_IMAGE_VERSION;
  const resolved = spawnSync(process.execPath, [script, projectRoot], {
    encoding: "utf8",
    env: defaultEnvironment,
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout, `${repositoryVersion}\n`);

  const rejected = spawnSync(process.execPath, [script, projectRoot], {
    encoding: "utf8",
    env: {
      ...defaultEnvironment,
      LOCAL_PRODUCTION_IMAGE_VERSION: "",
    },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /LOCAL_PRODUCTION_IMAGE_VERSION must exactly match repository VERSION/u,
  );

  for (const arguments_ of [[], [projectRoot, projectRoot]]) {
    const invalidUsage = spawnSync(process.execPath, [script, ...arguments_], {
      encoding: "utf8",
      env: defaultEnvironment,
    });
    assert.notEqual(invalidUsage.status, 0);
    assert.match(invalidUsage.stderr, /usage: resolve-image-version\.mjs PROJECT_ROOT/u);
  }
});
