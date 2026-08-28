import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";

import {
  createReleaseManifest,
  UNAVAILABLE_RELEASE_REVISION,
} from "../../web/scripts/release-manifest.mjs";
import {
  verifyLocalReleaseIdentity,
  verifyLocalReleasePayload,
} from "./verify-release-identity.mjs";

const files = [
  { path: "assets/app.js", bytes: 7, sha256: "a".repeat(64) },
  { path: "index.html", bytes: 11, sha256: "b".repeat(64) },
];
const version = "1.3.0";
const revision = "c".repeat(40);
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(candidateVersion = version, candidateRevision = revision) {
  return createReleaseManifest({
    version: candidateVersion,
    revision: candidateRevision,
    files,
    requireRevision: candidateRevision !== UNAVAILABLE_RELEASE_REVISION,
  });
}

test("returns the canonical releaseId only for the exact version and revision", () => {
  const candidate = manifest();
  assert.equal(verifyLocalReleaseIdentity({
    manifest: candidate,
    expectedVersion: version,
    expectedRevision: revision,
  }).releaseId, candidate.releaseId);
  assert.equal(verifyLocalReleaseIdentity({
    manifest: candidate,
    expectedVersion: version,
    expectedRevision: revision,
    expectedReleaseId: candidate.releaseId,
  }).releaseId, candidate.releaseId);
});

test("rejects anonymous, wrong complete, and malformed revisions", () => {
  assert.throws(() => verifyLocalReleaseIdentity({
    manifest: manifest(version, UNAVAILABLE_RELEASE_REVISION),
    expectedVersion: version,
    expectedRevision: revision,
  }), /complete lowercase Git commit/u);

  assert.throws(() => verifyLocalReleaseIdentity({
    manifest: manifest(version, "d".repeat(40)),
    expectedVersion: version,
    expectedRevision: revision,
  }), /does not match the source candidate/u);

  const malformed = { ...manifest(), revision: "abcdef0" };
  assert.throws(() => verifyLocalReleaseIdentity({
    manifest: malformed,
    expectedVersion: version,
    expectedRevision: revision,
  }), /complete lowercase Git commit/u);
});

test("rejects a changed identity with identical assets and an invalid expected releaseId", () => {
  const prepared = manifest();
  const changed = manifest("1.3.1", revision);
  assert.deepEqual(changed.files, prepared.files);
  assert.notEqual(changed.releaseId, prepared.releaseId);
  assert.throws(() => verifyLocalReleaseIdentity({
    manifest: changed,
    expectedVersion: "1.3.1",
    expectedRevision: revision,
    expectedReleaseId: prepared.releaseId,
  }), /does not match the prepared candidate/u);
  assert.throws(() => verifyLocalReleaseIdentity({
    manifest: prepared,
    expectedVersion: version,
    expectedRevision: revision,
    expectedReleaseId: "not-a-release-id",
  }), /releaseId is invalid/u);
});

function makeStaticRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "slots-release-payload-"));
  temporaryRoots.push(root);
  mkdirSync(resolve(root, "assets"));
  const contents = new Map([
    ["assets/app.js", "export const ready = true;\n"],
    ["index.html", "<!doctype html><title>Ready</title>\n"],
  ]);
  for (const [path, content] of contents) writeFileSync(resolve(root, path), content, "utf8");
  const payloadFiles = [...contents].map(([path, content]) => ({
    path,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  }));
  const releaseManifest = createReleaseManifest({
    version,
    revision,
    files: payloadFiles,
    requireRevision: true,
  });
  writeFileSync(
    resolve(root, "release-manifest.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    "utf8",
  );
  return { root, releaseManifest };
}

test("verifies every static payload byte and rejects extra or replaced files", async () => {
  const fixture = makeStaticRoot();
  assert.equal((await verifyLocalReleasePayload({
    staticRoot: fixture.root,
    expectedVersion: version,
    expectedRevision: revision,
    expectedReleaseId: fixture.releaseManifest.releaseId,
  })).releaseId, fixture.releaseManifest.releaseId);

  writeFileSync(resolve(fixture.root, "backdoor.js"), "unlisted\n", "utf8");
  await assert.rejects(() => verifyLocalReleasePayload({
    staticRoot: fixture.root,
    expectedVersion: version,
    expectedRevision: revision,
    expectedReleaseId: fixture.releaseManifest.releaseId,
  }), /file outside release-manifest/u);
  rmSync(resolve(fixture.root, "backdoor.js"));

  writeFileSync(resolve(fixture.root, "assets", "app.js"), "replaced payload\n", "utf8");
  await assert.rejects(() => verifyLocalReleasePayload({
    staticRoot: fixture.root,
    expectedVersion: version,
    expectedRevision: revision,
    expectedReleaseId: fixture.releaseManifest.releaseId,
  }), /byte length does not match|SHA-256 does not match/u);
});
