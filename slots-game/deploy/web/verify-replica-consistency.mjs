#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { verifyReleaseManifest } from "../../web/scripts/release-manifest.mjs";

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const MAX_REPLICAS = 64;

export class ReplicaConsistencyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplicaConsistencyError";
  }
}

function fail(message) {
  throw new ReplicaConsistencyError(message);
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function manifestUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an absolute HTTP URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== ""
    || !parsed.pathname.endsWith("/release-manifest.json")) {
    fail(`${label} must be a credential-free release-manifest HTTP URL without query or fragment`);
  }
  return parsed.href;
}

async function limitedBody(response, maxBytes, label) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      fail(`${label} response body exceeds the configured limit`);
    }
  }
  if (!response.body) fail(`${label} response has no body`);

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) fail(`${label} response body exceeds the configured limit`);
    chunks.push(chunk);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    fail(`${label} response is not valid UTF-8`);
  }
}

async function fetchManifest(url, index, { timeoutMs, maxBytes, fetchImpl }) {
  const label = `replica ${index + 1}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      fail(`${label} request failed or timed out`);
    }
    if (response.status !== 200) fail(`${label} returned HTTP ${response.status}`);
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      fail(`${label} returned an unexpected content type`);
    }
    const cacheDirectives = (response.headers.get("cache-control") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase());
    if (!cacheDirectives.includes("no-store")) fail(`${label} release manifest is cacheable`);
    const contentSecurityPolicy = response.headers.get("content-security-policy");
    if (!contentSecurityPolicy || contentSecurityPolicy.includes("*")) {
      fail(`${label} returned a missing or broad Content-Security-Policy`);
    }

    let parsed;
    try {
      parsed = JSON.parse(await limitedBody(response, maxBytes, label));
    } catch (error) {
      if (error instanceof ReplicaConsistencyError) throw error;
      if (controller.signal.aborted) fail(`${label} request failed or timed out`);
      fail(`${label} returned invalid JSON`);
    }
    try {
      return {
        manifest: verifyReleaseManifest(parsed, { requireRevision: true }),
        contentSecurityPolicy,
      };
    } catch {
      fail(`${label} returned an invalid release manifest`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 该检查必须直连每个待接流量的副本，禁止经过会合并响应的 Service 或 CDN。比较前先
 * 复算清单，避免仅比较服务端自报的 releaseId。请求严格限制时长、响应体和重定向。
 */
export async function verifyReplicaConsistency({
  urls,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = globalThis.fetch,
}) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > MAX_REPLICAS) {
    fail(`replica URL count must be between 2 and ${MAX_REPLICAS}`);
  }
  if (typeof fetchImpl !== "function") fail("Fetch API is unavailable");
  const timeout = boundedInteger(timeoutMs, "timeout", 100, 30_000);
  const bodyLimit = boundedInteger(maxBytes, "max bytes", 1_024, 4_194_304);
  const normalizedUrls = urls.map((url, index) => manifestUrl(url, `replica ${index + 1}`));
  if (new Set(normalizedUrls).size !== normalizedUrls.length) fail("replica URLs must be distinct");

  const manifests = await Promise.all(normalizedUrls.map((url, index) => (
    fetchManifest(url, index, { timeoutMs: timeout, maxBytes: bodyLimit, fetchImpl })
  )));
  const referenceManifest = JSON.stringify(manifests[0].manifest);
  if (manifests.some(({ manifest }) => JSON.stringify(manifest) !== referenceManifest)) {
    fail("replica release manifests differ");
  }
  const referencePolicy = manifests[0].contentSecurityPolicy;
  if (manifests.some(({ contentSecurityPolicy }) => contentSecurityPolicy !== referencePolicy)) {
    fail("replica Content-Security-Policy headers differ");
  }
  return { replicas: manifests.length, releaseId: manifests[0].manifest.releaseId };
}

function parseArguments(argv) {
  const urls = [];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxBytes = DEFAULT_MAX_BYTES;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${name ?? "argument"}`);
    if (name === "--replica") urls.push(value);
    else if (name === "--timeout-ms") timeoutMs = value;
    else if (name === "--max-bytes") maxBytes = value;
    else fail(`unknown argument ${name}`);
    index += 1;
  }
  return { urls, timeoutMs, maxBytes };
}

async function main(argv) {
  const result = await verifyReplicaConsistency(parseArguments(argv));
  process.stdout.write(`web replica consistency: ok (${result.replicas} replicas, ${result.releaseId})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`web replica consistency: ${error instanceof Error ? error.message : "verification failed"}\n`);
    process.exitCode = 1;
  });
}
