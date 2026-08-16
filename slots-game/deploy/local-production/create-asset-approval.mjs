import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  process.stderr.write(`local production asset approval: ${message}\n`);
  process.exit(1);
}

const [manifestArgument, outputArgument] = process.argv.slice(2);
if (!manifestArgument || !outputArgument) {
  fail("usage: create-asset-approval.mjs MANIFEST OUTPUT");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(manifestArgument), "utf8"));
} catch {
  fail("release manifest cannot be read");
}
if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
  fail("release manifest has an unsupported shape");
}

const protectedPrefixes = [
  "assets/primal-runtime/",
  "assets/primal-reference/",
  "assets/brand/",
];
const assets = manifest.files.filter((entry) => (
  entry && typeof entry.path === "string"
  && protectedPrefixes.some((prefix) => entry.path.startsWith(prefix))
));
if (assets.length === 0) fail("release manifest contains no protected assets");

const now = new Date();
const expires = new Date(now.getTime());
expires.setUTCFullYear(expires.getUTCFullYear() + 1);
const approval = {
  schemaVersion: 1,
  status: "APPROVED",
  approvalReference: "user-authorized-local-technical-production",
  jurisdictions: ["LOCAL"],
  expiresAt: expires.toISOString(),
  assets,
};

let descriptor;
try {
  descriptor = openSync(resolve(outputArgument), "wx", 0o600);
  writeFileSync(descriptor, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  closeSync(descriptor);
} catch {
  if (descriptor !== undefined) closeSync(descriptor);
  fail("output must be a new writable file");
}
process.stdout.write(`local production asset approval: ${assets.length} exact files bound\n`);
