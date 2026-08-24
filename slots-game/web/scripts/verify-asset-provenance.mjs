import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTECTED_RELEASE_ASSET_EXACT_PATHS,
  PROTECTED_RELEASE_ASSET_PREFIXES,
  isProtectedReleaseAsset,
} from "./verify-release-asset-approval.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(scriptPath), "..");
const publicRoot = resolve(webRoot, "public");
const provenancePath = resolve(webRoot, "asset-provenance.json");
const ALLOWED_UNPROTECTED_PUBLIC_FILES = new Set(["THIRD_PARTY_NOTICES.txt"]);
const ALLOWED_EVIDENCE = new Set(["OWNER_ASSERTED_FIRST_PARTY", "UNVERIFIED_IN_REPOSITORY"]);

function fail(message) {
  throw new Error(`asset provenance: ${message}`);
}

function slash(path) {
  return path.split(sep).join("/");
}

async function filesUnder(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(slash(relative(root, path)));
      else fail(`public tree contains a non-regular entry: ${slash(relative(root, path))}`);
    }
  }
  await visit(root);
  return output.sort();
}

function validateInventory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("inventory must be an object");
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (value.policy !== "DENY_COMMERCIAL_RELEASE_WITHOUT_EXTERNAL_EXACT_HASH_APPROVAL") {
    fail("policy must remain fail-closed");
  }
  if (!Array.isArray(value.groups)) fail("groups must be an array");

  const expected = new Map([
    ...PROTECTED_RELEASE_ASSET_EXACT_PATHS.map((selector) => [selector, "exact"]),
    ...PROTECTED_RELEASE_ASSET_PREFIXES.map((selector) => [selector, "prefix"]),
  ]);
  const observed = new Set();
  for (const [index, group] of value.groups.entries()) {
    if (!group || typeof group !== "object" || Array.isArray(group)) fail(`groups[${index}] must be an object`);
    if (typeof group.selector !== "string" || !expected.has(group.selector)) {
      fail(`groups[${index}].selector is not a protected release selector`);
    }
    if (observed.has(group.selector)) fail(`duplicate selector: ${group.selector}`);
    if (group.match !== expected.get(group.selector)) fail(`invalid match for selector: ${group.selector}`);
    if (!ALLOWED_EVIDENCE.has(group.repositoryEvidence)) {
      fail(`invalid repositoryEvidence for selector: ${group.selector}`);
    }
    if (group.releaseDisposition !== "EXTERNAL_APPROVAL_REQUIRED") {
      fail(`selector must require external approval: ${group.selector}`);
    }
    observed.add(group.selector);
  }
  for (const selector of expected.keys()) {
    if (!observed.has(selector)) fail(`missing protected selector: ${selector}`);
  }
  if (observed.size !== expected.size) fail("inventory contains an unexpected selector");
}

export async function verifyAssetProvenance({
  publicDirectory = publicRoot,
  inventoryPath = provenancePath,
} = {}) {
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch {
    fail("asset-provenance.json cannot be read as JSON");
  }
  validateInventory(inventory);

  const publicFiles = await filesUnder(publicDirectory);
  const forbidden = publicFiles.filter((path) => (
    /(?:^|\/)(?:README(?:\.[^/]*)?|screenshots?|captures?|tests?|tmp)(?:\/|$)/i.test(path)
    || /\.(?:md|map)$/i.test(path)
    || /(?:^|\/)\.DS_Store$/.test(path)
  ));
  if (forbidden.length > 0) fail(`public tree contains documentation or evidence files:\n${forbidden.join("\n")}`);

  const unclassified = publicFiles.filter((path) => (
    !isProtectedReleaseAsset(path) && !ALLOWED_UNPROTECTED_PUBLIC_FILES.has(path)
  ));
  if (unclassified.length > 0) fail(`public files are outside the release policy:\n${unclassified.join("\n")}`);

  const protectedCount = publicFiles.filter(isProtectedReleaseAsset).length;
  if (protectedCount === 0) fail("public tree contains no protected release assets");
  return { protectedCount, publicFileCount: publicFiles.length };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await verifyAssetProvenance();
    process.stdout.write(
      `asset provenance: ok (${result.protectedCount}/${result.publicFileCount} protected public files)\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "asset provenance: unexpected error"}\n`);
    process.exitCode = 1;
  }
}
