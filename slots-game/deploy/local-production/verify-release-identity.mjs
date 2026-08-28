#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyWebStaticRoot } from "../supply-chain/verify-web-static-root.mjs";
import { verifyReleaseManifest } from "../../web/scripts/release-manifest.mjs";

const RELEASE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function verifyLocalReleaseIdentity({
  manifest,
  expectedVersion,
  expectedRevision,
  expectedReleaseId,
}) {
  const verified = verifyReleaseManifest(manifest, { requireRevision: true });
  if (verified.version !== expectedVersion || verified.revision !== expectedRevision) {
    throw new Error("release manifest version or revision does not match the source candidate");
  }
  if (expectedReleaseId !== undefined) {
    if (typeof expectedReleaseId !== "string" || !RELEASE_ID_PATTERN.test(expectedReleaseId)) {
      throw new Error("expected release manifest releaseId is invalid");
    }
    if (verified.releaseId !== expectedReleaseId) {
      throw new Error("release manifest releaseId does not match the prepared candidate");
    }
  }
  return verified;
}

export async function verifyLocalReleasePayload({
  staticRoot,
  expectedVersion,
  expectedRevision,
  expectedReleaseId,
}) {
  const manifest = await verifyWebStaticRoot(staticRoot);
  return verifyLocalReleaseIdentity({
    manifest,
    expectedVersion,
    expectedRevision,
    expectedReleaseId,
  });
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  if (process.argv.length < 5 || process.argv.length > 6) {
    throw new Error(
      "usage: verify-release-identity.mjs STATIC_ROOT EXPECTED_VERSION EXPECTED_REVISION [EXPECTED_RELEASE_ID]",
    );
  }
  const verified = await verifyLocalReleasePayload({
    staticRoot: process.argv[2],
    expectedVersion: process.argv[3],
    expectedRevision: process.argv[4],
    expectedReleaseId: process.argv[5],
  });
  process.stdout.write(`${verified.releaseId}\n`);
}
