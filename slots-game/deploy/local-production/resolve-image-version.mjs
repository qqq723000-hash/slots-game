#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseVersion } from "../supply-chain/verify-release-version.mjs";

const overrideName = "LOCAL_PRODUCTION_IMAGE_VERSION";

export function resolveLocalImageVersion(projectRoot, environment = process.env) {
  const repositoryVersion = verifyReleaseVersion(projectRoot);
  if (Object.hasOwn(environment, overrideName) && environment[overrideName] !== repositoryVersion) {
    throw new Error(`${overrideName} must exactly match repository VERSION`);
  }
  return repositoryVersion;
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  if (process.argv.length !== 3) {
    throw new Error("usage: resolve-image-version.mjs PROJECT_ROOT");
  }
  process.stdout.write(`${resolveLocalImageVersion(process.argv[2])}\n`);
}
