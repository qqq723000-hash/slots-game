import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  BASE_CONTENT_SECURITY_POLICY,
  CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE,
  LAUNCH_FRAGMENT_SCRUB_CSP_SOURCE,
  contentSecurityPolicyFromHeaders,
  createReleaseContentSecurityPolicy,
  parseContentSecurityPolicy,
  verifyBaseContentSecurityPolicy,
  verifyReleaseContentSecurityPolicy,
} from "./content-security-policy.mjs";

const releaseOptions = {
  rgsBaseUrl: "https://rgs.example/client/v1",
  hostOrigin: "https://operator.example",
};

test("基础与发布策略只接受审核过的完整语义集合", () => {
  assert.equal(verifyBaseContentSecurityPolicy(BASE_CONTENT_SECURITY_POLICY), BASE_CONTENT_SECURITY_POLICY);
  assert.equal(parseContentSecurityPolicy(BASE_CONTENT_SECURITY_POLICY).size, 14);
  const releasePolicy = createReleaseContentSecurityPolicy(releaseOptions);
  assert.equal(verifyReleaseContentSecurityPolicy(releasePolicy, releaseOptions), releasePolicy);
  assert.match(releasePolicy, /form-action 'none'/u);
  assert.match(releasePolicy, /trusted-types slots-game-static-html/u);
  assert.match(releasePolicy, /require-trusted-types-for 'script'/u);
  assert.match(releasePolicy, new RegExp(
    `script-src 'self' ${LAUNCH_FRAGMENT_SCRUB_CSP_SOURCE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
    "u",
  ));
  assert.match(releasePolicy, /connect-src 'self' https:\/\/rgs\.example/u);
  assert.match(releasePolicy, /frame-ancestors https:\/\/operator\.example/u);
});

test("内联启动片段清理器字节与唯一 CSP hash 精确绑定", () => {
  const indexSource = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  const match = indexSource.match(
    /<script id="launch-fragment-scrub">([\s\S]*?)<\/script>/u,
  );
  assert.ok(match, "launch fragment scrub must be present");
  const actual = `'sha256-${createHash("sha256").update(match[1], "utf8").digest("base64")}'`;
  assert.equal(actual, LAUNCH_FRAGMENT_SCRUB_CSP_SOURCE);
  assert.deepEqual(
    parseContentSecurityPolicy(BASE_CONTENT_SECURITY_POLICY).get("script-src"),
    ["'self'", LAUNCH_FRAGMENT_SCRUB_CSP_SOURCE],
  );
});

test("共享浏览器探针记录 CSP 违规且不保留敏感 URL 细节", () => {
  let violationListener;
  const context = {
    URL,
    location: { origin: "https://slots.example" },
    addEventListener: (name, listener) => {
      if (name === "securitypolicyviolation") violationListener = listener;
    },
  };
  runInNewContext(CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE, context);
  assert.equal(typeof violationListener, "function");
  violationListener({
    effectiveDirective: "script-src-elem",
    violatedDirective: "script-src-elem",
    disposition: "enforce",
    blockedURI: "https://invalid.example/private.js?accessToken=secret#launch",
    sourceFile: "https://slots.example/private/game-ui-ABC123.js?token=secret#launch",
    lineNumber: 435,
    columnNumber: 42,
    sample: "Element innerHTML|<img src=x data-token=secret>",
  });
  const violations = JSON.parse(JSON.stringify(
    context.__slotsContentSecurityPolicyProbe.violations,
  ));
  assert.deepEqual(violations, [{
    effectiveDirective: "script-src-elem",
    violatedDirective: "script-src-elem",
    disposition: "enforce",
    blockedTarget: "https://invalid.example",
    sourceFile: "game-ui-ABC123.js",
    lineNumber: 435,
    columnNumber: 42,
    trustedTypesSink: "Element innerHTML",
  }]);
  assert.doesNotMatch(JSON.stringify(violations), /private|accessToken|secret|launch/u);
});

test("语义比较允许指令排序变化但仍返回唯一规范文本", () => {
  const canonical = createReleaseContentSecurityPolicy(releaseOptions);
  const reordered = canonical.split("; ").reverse().join("; ");
  assert.equal(verifyReleaseContentSecurityPolicy(reordered, releaseOptions), canonical);
});

for (const drift of [
  BASE_CONTENT_SECURITY_POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
  BASE_CONTENT_SECURITY_POLICY.replace(LAUNCH_FRAGMENT_SCRUB_CSP_SOURCE, "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='"),
  BASE_CONTENT_SECURITY_POLICY.replace("connect-src 'self'", "connect-src https:"),
  BASE_CONTENT_SECURITY_POLICY.replace("object-src 'none'", "object-src 'self'"),
  BASE_CONTENT_SECURITY_POLICY.replace("base-uri 'self'", "base-uri *"),
  BASE_CONTENT_SECURITY_POLICY.replace("form-action 'none'; ", ""),
  BASE_CONTENT_SECURITY_POLICY.replace("trusted-types slots-game-static-html", "trusted-types *"),
  BASE_CONTENT_SECURITY_POLICY.replace("trusted-types slots-game-static-html; ", ""),
  BASE_CONTENT_SECURITY_POLICY.replace("require-trusted-types-for 'script'; ", ""),
  BASE_CONTENT_SECURITY_POLICY.replace("require-trusted-types-for 'script'", "require-trusted-types-for *"),
  `${BASE_CONTENT_SECURITY_POLICY}; upgrade-insecure-requests 'self'`,
  `${BASE_CONTENT_SECURITY_POLICY}; script-src 'self'`,
]) {
  test(`拒绝基础策略漂移 ${JSON.stringify(drift.slice(0, 72))}`, () => {
    assert.throws(() => verifyBaseContentSecurityPolicy(drift), /Content-Security-Policy/u);
  });
}

test("解析器拒绝空指令、重复 source 和换行注入", () => {
  assert.throws(() => parseContentSecurityPolicy("default-src 'self';; script-src 'self'"), /empty/u);
  assert.throws(() => parseContentSecurityPolicy("default-src 'self' 'self'"), /duplicate sources/u);
  assert.throws(() => parseContentSecurityPolicy("default-src 'self'\nscript-src *"), /non-canonical/u);
});

test("原始响应头必须只包含一条 CSP", () => {
  const policy = createReleaseContentSecurityPolicy(releaseOptions);
  assert.equal(contentSecurityPolicyFromHeaders(`HTTP/2 200\r\ncontent-security-policy: ${policy}\r\n`), policy);
  assert.throws(() => contentSecurityPolicyFromHeaders("HTTP/2 200\r\n"), /exactly one/u);
  assert.throws(() => contentSecurityPolicyFromHeaders(
    `Content-Security-Policy: ${policy}\r\ncontent-security-policy: ${policy}\r\n`,
  ), /exactly one/u);
});

for (const [name, value] of [
  ["RGS 明文协议", { rgsBaseUrl: "http://rgs.example", hostOrigin: "https://operator.example" }],
  ["RGS 携带凭据", { rgsBaseUrl: "https://user@rgs.example", hostOrigin: "https://operator.example" }],
  ["运营方路径", { rgsBaseUrl: "https://rgs.example", hostOrigin: "https://operator.example/path" }],
]) {
  test(`拒绝非规范发布 origin：${name}`, () => {
    assert.throws(() => createReleaseContentSecurityPolicy(value), /credential-free HTTPS/u);
  });
}

test("命令行从标准输入复用相同的发布策略校验", () => {
  const script = new URL("./content-security-policy.mjs", import.meta.url);
  const policy = createReleaseContentSecurityPolicy(releaseOptions);
  const argumentsList = [
    script.pathname,
    "--rgs-base-url", releaseOptions.rgsBaseUrl,
    "--host-origin", releaseOptions.hostOrigin,
  ];
  const accepted = spawnSync(process.execPath, argumentsList, {
    input: `HTTP/1.1 200 OK\r\nContent-Security-Policy: ${policy}\r\n\r\n`,
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  const rejected = spawnSync(process.execPath, argumentsList, {
    input: `HTTP/1.1 200 OK\r\nContent-Security-Policy: ${policy} *\r\n\r\n`,
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0);
});
