import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyReleaseVersion } from "./verify-release-version.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "slots-release-version-"));
  mkdirSync(join(root, "web"), { recursive: true });
  mkdirSync(join(root, "server"), { recursive: true });
  mkdirSync(join(root, "deploy/cluster-production/chart"), { recursive: true });
  writeFileSync(join(root, "VERSION"), "1.1.1\n");
  writeFileSync(join(root, "CHANGELOG.md"), "# 变更记录\n\n## 未发布\n\n## 1.1.1 - 2026-08-26\n\n- fixed\n\n## 1.1.0 - 2026-08-25\n\n- older\n");
  writeFileSync(join(root, "web/package.json"), '{"private":true,"version":"1.1.1"}\n');
  writeFileSync(join(root, "web/package-lock.json"), '{"version":"1.1.1","packages":{"":{"version":"1.1.1"}}}\n');
  writeFileSync(join(root, "deploy/cluster-production/chart/Chart.yaml"), 'apiVersion: v2\nversion: 1.1.1\nappVersion: "1.1.1"\n');
  writeFileSync(join(root, "server/openapi.yaml"), 'openapi: 3.1.0\ninfo:\n  version: 1.1.1\n');
  writeFileSync(join(root, "README.md"), "# Primal Rampage\n\n```sh\nWEB_RELEASE_VERSION=1.1.1 \\\n```\n");
  writeFileSync(join(root, "web/README.md"), "# Web\n\n```sh\nWEB_RELEASE_VERSION=1.1.1 \\\n```\n");
  return root;
}

function rejectsMutation(mutator, expected) {
  const root = fixture();
  try {
    mutator(root);
    assert.throws(() => verifyReleaseVersion(root), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts one synchronized release version in ordinary and formal modes", () => {
  const root = fixture();
  try {
    assert.equal(verifyReleaseVersion(root), "1.1.1");
    assert.equal(verifyReleaseVersion(root, { formal: true }), "1.1.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects non-canonical or non-terminated VERSION", () => {
  rejectsMutation((root) => writeFileSync(join(root, "VERSION"), "01.1.1\n"), /canonical/u);
  rejectsMutation((root) => writeFileSync(join(root, "VERSION"), "1.1.1"), /LF-terminated/u);
});

test("rejects changelog drift while ordinary mode permits pending notes", () => {
  rejectsMutation((root) => writeFileSync(join(root, "VERSION"), "1.1.2\n"), /newest CHANGELOG/u);
  const root = fixture();
  try {
    writeFileSync(join(root, "CHANGELOG.md"), "# 变更记录\n\n## 未发布\n\n- pending\n\n## 1.1.1 - 2026-08-26\n\n- fixed\n");
    assert.equal(verifyReleaseVersion(root), "1.1.1");
    assert.throws(
      () => verifyReleaseVersion(root, { formal: true }),
      /未发布 must be empty/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects package and lockfile version drift", () => {
  rejectsMutation((root) => writeFileSync(join(root, "web/package.json"), '{"private":true,"version":"1.1.0"}\n'), /package\.json/u);
  rejectsMutation((root) => writeFileSync(join(root, "web/package-lock.json"), '{"version":"1.1.1","packages":{"":{"version":"1.1.0"}}}\n'), /package-lock/u);
});

test("rejects Helm and documentation version drift", () => {
  rejectsMutation((root) => writeFileSync(join(root, "deploy/cluster-production/chart/Chart.yaml"), 'apiVersion: v2\nversion: 1.1.0\nappVersion: "1.1.1"\n'), /Chart version/u);
  rejectsMutation((root) => writeFileSync(join(root, "web/README.md"), "# Web\n\nWEB_RELEASE_VERSION=1.1.0 \\\n"), /release example/u);
});

test("rejects OpenAPI version drift", () => {
  rejectsMutation(
    (root) => writeFileSync(join(root, "server/openapi.yaml"), 'openapi: 3.1.0\ninfo:\n  version: 1.1.0\n'),
    /OpenAPI/u,
  );
});

test("rejects a VERSION symlink", () => {
  const root = fixture();
  try {
    rmSync(join(root, "VERSION"));
    writeFileSync(join(root, "real-version"), "1.1.1\n");
    symlinkSync("real-version", join(root, "VERSION"));
    assert.throws(() => verifyReleaseVersion(root), /regular file/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
