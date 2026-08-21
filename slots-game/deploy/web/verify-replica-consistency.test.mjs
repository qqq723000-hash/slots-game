import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after } from "node:test";

import { createReleaseManifest } from "../../web/scripts/release-manifest.mjs";
import { createReleaseContentSecurityPolicy } from "./content-security-policy.mjs";
import { verifyReplicaConsistency } from "./verify-replica-consistency.mjs";

const servers = [];
after(async () => Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))));

const identity = {
  version: "2026.08.16",
  revision: "0123456789abcdef0123456789abcdef01234567",
};
const policyOptions = {
  rgsBaseUrl: "https://rgs.example/client/v1",
  hostOrigin: "https://operator.example",
};
const releasePolicy = createReleaseContentSecurityPolicy(policyOptions);

function verify(options) {
  return verifyReplicaConsistency({ ...policyOptions, ...options });
}

function manifest(character = "a") {
  return createReleaseManifest({
    ...identity,
    requireRevision: true,
    files: [{ path: "index.html", bytes: 12, sha256: character.repeat(64) }],
  });
}

async function replica(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/release-manifest.json`;
}

function jsonReplica(value, options = {}) {
  return replica((_request, response) => {
    response.statusCode = options.status ?? 200;
    response.setHeader("Content-Type", options.contentType ?? "application/json; charset=utf-8");
    response.setHeader("Cache-Control", options.cacheControl ?? "no-store, max-age=0");
    response.setHeader("Content-Security-Policy", options.contentSecurityPolicy
      ?? releasePolicy);
    response.end(options.body ?? `${JSON.stringify(value)}\n`);
  });
}

test("accepts multiple independently addressed replicas with identical canonical manifests", async () => {
  const urls = await Promise.all([jsonReplica(manifest()), jsonReplica(manifest()), jsonReplica(manifest())]);
  const result = await verify({ urls });
  assert.equal(result.replicas, 3);
  assert.match(result.releaseId, /^sha256:[0-9a-f]{64}$/);
});

test("fails closed when one replica serves different release bytes", async () => {
  const urls = await Promise.all([jsonReplica(manifest("a")), jsonReplica(manifest("b"))]);
  await assert.rejects(verify({ urls }), /manifests differ/);
});

test("fails closed when replicas expose different immutable origin policies", async () => {
  const urls = await Promise.all([
    jsonReplica(manifest()),
    jsonReplica(manifest(), {
      contentSecurityPolicy: releasePolicy.replace(
        "connect-src 'self' https://rgs.example",
        "connect-src 'self' https://other-rgs.example",
      ),
    }),
  ]);
  await assert.rejects(verify({ urls }), /invalid Content-Security-Policy/);
});

test("语义相同但响应文本漂移的副本仍拒绝混入同一流量池", async () => {
  const reorderedPolicy = releasePolicy.split("; ").reverse().join("; ");
  const urls = await Promise.all([
    jsonReplica(manifest()),
    jsonReplica(manifest(), { contentSecurityPolicy: reorderedPolicy }),
  ]);
  await assert.rejects(verify({ urls }), /Content-Security-Policy headers differ/);
});

test("即使所有副本一致也拒绝宽松或缺失指令的策略", async () => {
  for (const contentSecurityPolicy of [
    releasePolicy.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
    releasePolicy.replace("form-action 'none'; ", ""),
    releasePolicy.replace("object-src 'none'", "object-src *"),
  ]) {
    const urls = await Promise.all([
      jsonReplica(manifest(), { contentSecurityPolicy }),
      jsonReplica(manifest(), { contentSecurityPolicy }),
    ]);
    await assert.rejects(verify({ urls }), /invalid Content-Security-Policy/);
  }
});

test("副本响应不得发送重复 CSP header", async () => {
  const urls = await Promise.all([
    jsonReplica(manifest()),
    jsonReplica(manifest(), { contentSecurityPolicy: [releasePolicy, releasePolicy] }),
  ]);
  await assert.rejects(verify({ urls }), /invalid Content-Security-Policy/);
});

test("rejects cacheable, oversized and redirected responses", async (context) => {
  await context.test("cacheable", async () => {
    const urls = await Promise.all([
      jsonReplica(manifest()),
      jsonReplica(manifest(), { cacheControl: "public, max-age=60" }),
    ]);
    await assert.rejects(verify({ urls }), /is cacheable/);
  });
  await context.test("oversized", async () => {
    const urls = await Promise.all([
      jsonReplica(manifest()),
      jsonReplica(manifest(), { body: "x".repeat(2_048) }),
    ]);
    await assert.rejects(verify({ urls, maxBytes: 1_024 }), /exceeds/);
  });
  await context.test("redirected", async () => {
    const redirected = await replica((_request, response) => {
      response.statusCode = 302;
      response.setHeader("Location", "/release-manifest.json");
      response.end();
    });
    const urls = [await jsonReplica(manifest()), redirected];
    await assert.rejects(verify({ urls }), /request failed/);
  });
});

test("aborts a stalled replica within the configured timeout", async () => {
  const stalledBeforeHeaders = await replica(() => undefined);
  const stalledBody = await replica((_request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      releasePolicy,
    );
    response.write("{");
  });
  const healthy = await jsonReplica(manifest());
  await assert.rejects(
    verify({ urls: [healthy, stalledBeforeHeaders], timeoutMs: 100 }),
    /timed out/,
  );
  await assert.rejects(
    verify({ urls: [healthy, stalledBody], timeoutMs: 100 }),
    /timed out/,
  );
});

test("rejects duplicate or credential-bearing replica URLs", async () => {
  const url = await jsonReplica(manifest());
  await assert.rejects(verify({ urls: [url, url] }), /must be distinct/);
  await assert.rejects(verify({
    urls: [url, "http://user:password@127.0.0.1/release-manifest.json"],
  }), /credential-free/);
});

test("副本门禁必须由发布参数提供预期 origin", async () => {
  const urls = await Promise.all([jsonReplica(manifest()), jsonReplica(manifest())]);
  await assert.rejects(verifyReplicaConsistency({ urls }), /expected release Content-Security-Policy is invalid/);
});
