import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "prepare-state.mjs");
const baseEnvironment = {
  ...process.env,
  LOCAL_PRODUCTION_IMAGE_CREATED: "2026-01-01T00:00:00Z",
  LOCAL_PRODUCTION_IMAGE_REVISION: "a".repeat(40),
  LOCAL_PRODUCTION_IMAGE_SOURCE: "https://github.com/qqq723000-hash/slots-game",
  LOCAL_PRODUCTION_IMAGE_VERSION: "contract-version",
  LOCAL_PRODUCTION_IMAGE_TAG: "candidate-one",
  LOCAL_PRODUCTION_ASSET_APPROVAL_HASH: "c".repeat(64),
};
const metadataEnvironmentNames = [
  "LOCAL_PRODUCTION_IMAGE_CREATED",
  "LOCAL_PRODUCTION_IMAGE_REVISION",
  "LOCAL_PRODUCTION_IMAGE_SOURCE",
  "LOCAL_PRODUCTION_IMAGE_VERSION",
  "LOCAL_PRODUCTION_IMAGE_TAG",
  "LOCAL_PRODUCTION_ASSET_APPROVAL_HASH",
];

function restrictedWrite(path, contents) {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function makeState() {
  const root = mkdtempSync(join(tmpdir(), "slots-prepare-state-"));
  const state = join(root, "state");
  const secrets = join(state, "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  chmodSync(secrets, 0o700);
  const approvalHash = "b".repeat(64);
  const requiredFiles = new Map([
    ["definition.json", "{}\n"],
    ["definition-approval.json", `${JSON.stringify({
      schema: "rgs-definition-approval-v2",
      approval: {
        gameId: "iron-colossus",
        version: "definition-current",
        sha256: approvalHash,
      },
    })}\n`],
    ["operators.json", `${JSON.stringify({
      schema: "rgs-operators-v2",
      operators: [{ operatorId: "local-operator" }],
    })}\n`],
    ["deployment-metadata.json", "{}\n"],
    ["postgres-admin.password", "postgres-admin-password\n"],
    ["rgs-migrator.password", "rgs-migrator-password\n"],
    ["rgs-runtime.password", "rgs-runtime-password\n"],
    ["local-operator-owner.password", "local-operator-owner-password\n"],
    ["local-operator-runtime.password", "local-operator-runtime-password\n"],
    ["local-production-root-ca.pem", "local-root-ca\n"],
  ]);
  for (const [name, contents] of requiredFiles) restrictedWrite(join(secrets, name), contents);
  return { root, state, secrets, approvalHash };
}

function runPrepare(state, environment, ...arguments_) {
  return spawnSync(process.execPath, [script, state, ...arguments_], {
    encoding: "utf8",
    env: environment,
  });
}

test("rejects surrounding image-metadata whitespace before creating derived state", () => {
  const fixture = makeState();
  try {
    for (const name of metadataEnvironmentNames) {
      const value = baseEnvironment[name];
      for (const invalidValue of [` ${value}`, `${value} `]) {
        const rejected = runPrepare(fixture.state, {
          ...baseEnvironment,
          [name]: invalidValue,
        }, "--validate-only");
        assert.notEqual(rejected.status, 0, `${name} accepted surrounding whitespace`);
        assert.match(rejected.stderr, new RegExp(`${name} must not contain surrounding whitespace`, "u"));
      }
    }
    assert.throws(() => statSync(join(fixture.secrets, "compose.env")), { code: "ENOENT" });
    assert.throws(() => statSync(join(fixture.secrets, "postgres-backup.password")), { code: "ENOENT" });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("validates before mutation, atomically selects a candidate, and preserves the last selector on invalid input", () => {
  const fixture = makeState();
  try {
    const validation = runPrepare(fixture.state, baseEnvironment, "--validate-only");
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(validation.stdout, "local production image metadata: valid\n");
    assert.throws(() => statSync(join(fixture.secrets, "compose.env")), { code: "ENOENT" });
    assert.throws(() => statSync(join(fixture.secrets, "postgres-backup.password")), { code: "ENOENT" });

    const first = runPrepare(fixture.state, baseEnvironment);
    assert.equal(first.status, 0, first.stderr);
    const composePath = join(fixture.secrets, "compose.env");
    const firstCompose = readFileSync(composePath, "utf8");
    assert.match(firstCompose, /^LOCAL_PRODUCTION_GAME_ID=iron-colossus$/mu);
    assert.match(firstCompose, new RegExp(`^LOCAL_PRODUCTION_DEFINITION_HASH=${fixture.approvalHash}$`, "mu"));
    assert.match(firstCompose, /^LOCAL_PRODUCTION_IMAGE_TAG=candidate-one$/mu);
    assert.match(firstCompose, new RegExp(`^LOCAL_PRODUCTION_ASSET_APPROVAL_HASH=${"c".repeat(64)}$`, "mu"));
    assert.equal(statSync(composePath).mode & 0o777, 0o600);
    assert.equal(readdirSync(fixture.secrets).some((name) => name.endsWith(".tmp")), false);

    const invalid = runPrepare(fixture.state, {
      ...baseEnvironment,
      LOCAL_PRODUCTION_IMAGE_TAG: "invalid/tag",
    });
    assert.notEqual(invalid.status, 0);
    assert.equal(readFileSync(composePath, "utf8"), firstCompose);

    const second = runPrepare(fixture.state, {
      ...baseEnvironment,
      LOCAL_PRODUCTION_IMAGE_TAG: "candidate-two",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.match(readFileSync(composePath, "utf8"), /^LOCAL_PRODUCTION_IMAGE_TAG=candidate-two$/mu);
    assert.equal(readdirSync(fixture.secrets).some((name) => name.endsWith(".tmp")), false);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
