#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const BASE_POLICY_SPECIFICATION = Object.freeze([
  Object.freeze(["default-src", Object.freeze(["'self'"])]),
  Object.freeze(["script-src", Object.freeze(["'self'"])]),
  Object.freeze(["style-src", Object.freeze(["'self'", "'unsafe-inline'"])]),
  Object.freeze(["img-src", Object.freeze(["'self'", "data:", "blob:"])]),
  Object.freeze(["font-src", Object.freeze(["'self'"])]),
  Object.freeze(["media-src", Object.freeze(["'self'", "blob:"])]),
  Object.freeze(["connect-src", Object.freeze(["'self'"])]),
  Object.freeze(["worker-src", Object.freeze(["'self'", "blob:"])]),
  Object.freeze(["object-src", Object.freeze(["'none'"])]),
  Object.freeze(["base-uri", Object.freeze(["'self'"])]),
  Object.freeze(["form-action", Object.freeze(["'none'"])]),
  Object.freeze(["frame-ancestors", Object.freeze(["'self'"])]),
]);

const MAXIMUM_HEADER_BYTES = 65_536;

export class ContentSecurityPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContentSecurityPolicyError";
  }
}

function fail(message) {
  throw new ContentSecurityPolicyError(message);
}

function serializeSpecification(specification) {
  return specification.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

export const BASE_CONTENT_SECURITY_POLICY = serializeSpecification(BASE_POLICY_SPECIFICATION);

// 浏览器门禁在文档创建前安装此探针；诊断只保留公开 directive 与 blocked origin，
// 不复制 URL 的路径、查询参数或 fragment。
export const CONTENT_SECURITY_POLICY_VIOLATION_PROBE_SOURCE = `(() => {
  const violations = [];
  const safeBlockedTarget = (value) => {
    const raw = String(value ?? '');
    if (['inline', 'eval', 'wasm-eval', 'trusted-types-sink', 'trusted-types-policy'].includes(raw)) {
      return raw;
    }
    try {
      const parsed = new URL(raw, location.origin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
      return parsed.protocol || '未知协议';
    } catch {
      return '无法解析的目标';
    }
  };
  const probe = {};
  Object.defineProperty(probe, 'violations', {
    enumerable: true,
    get: () => violations.slice(),
  });
  Object.defineProperty(globalThis, '__slotsContentSecurityPolicyProbe', {
    configurable: false,
    writable: false,
    value: probe,
  });
  globalThis.addEventListener('securitypolicyviolation', (event) => {
    if (violations.length >= 16) return;
    violations.push({
      effectiveDirective: String(event.effectiveDirective ?? '').slice(0, 64),
      violatedDirective: String(event.violatedDirective ?? '').slice(0, 64),
      disposition: String(event.disposition ?? '').slice(0, 32),
      blockedTarget: safeBlockedTarget(event.blockedURI),
    });
  }, true);
})();`;

function exactHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an exact credential-free HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
    || parsed.origin !== value) {
    fail(`${label} must be an exact credential-free HTTPS origin`);
  }
  return parsed.origin;
}

function rgsHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("RGS base URL must be a credential-free HTTPS origin/path");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "") {
    fail("RGS base URL must be a credential-free HTTPS origin/path");
  }
  return parsed.origin;
}

function releaseSpecification(options) {
  const rgsOrigin = rgsHttpsOrigin(options?.rgsBaseUrl);
  const hostOrigin = exactHttpsOrigin(options?.hostOrigin, "operator host origin");
  return BASE_POLICY_SPECIFICATION.map(([name, sources]) => {
    if (name === "connect-src") return [name, ["'self'", rgsOrigin]];
    if (name === "frame-ancestors") return [name, [hostOrigin]];
    return [name, [...sources]];
  });
}

/**
 * CSP 的指令顺序不影响语义，因此解析后按名称比较；指令和 source 重复一律拒绝，避免
 * 浏览器“首条生效”等兼容行为掩盖配置漂移。
 */
export function parseContentSecurityPolicy(policy) {
  if (typeof policy !== "string" || policy.trim() === "") {
    fail("Content-Security-Policy must be a non-empty string");
  }
  if (policy !== policy.trim() || /[\r\n\\]/u.test(policy)) {
    fail("Content-Security-Policy contains non-canonical whitespace or escaped text");
  }
  const segments = policy.split(";");
  if (segments.at(-1)?.trim() === "") segments.pop();
  if (segments.length === 0 || segments.some((segment) => segment.trim() === "")) {
    fail("Content-Security-Policy contains an empty directive");
  }

  const directives = new Map();
  for (const segment of segments) {
    const [rawName, ...sources] = segment.trim().split(/[\t ]+/u);
    const name = rawName.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) {
      fail(`Content-Security-Policy contains invalid directive ${rawName}`);
    }
    if (directives.has(name)) {
      fail(`Content-Security-Policy contains duplicate directive ${name}`);
    }
    if (sources.length === 0) {
      fail(`Content-Security-Policy directive ${name} has no source`);
    }
    if (new Set(sources).size !== sources.length) {
      fail(`Content-Security-Policy directive ${name} contains duplicate sources`);
    }
    directives.set(name, sources);
  }
  return directives;
}

function verifySpecification(policy, specification, label) {
  const directives = parseContentSecurityPolicy(policy);
  if (directives.size !== specification.length) {
    fail(`${label} must contain exactly ${specification.length} reviewed directives`);
  }
  for (const [name, expectedSources] of specification) {
    const actualSources = directives.get(name);
    if (!actualSources) fail(`${label} is missing directive ${name}`);
    if (actualSources.length !== expectedSources.length
      || expectedSources.some((source) => !actualSources.includes(source))) {
      fail(`${label} directive ${name} does not match the reviewed sources`);
    }
  }
  return serializeSpecification(specification);
}

export function verifyBaseContentSecurityPolicy(policy) {
  return verifySpecification(policy, BASE_POLICY_SPECIFICATION, "base Content-Security-Policy");
}

export function createReleaseContentSecurityPolicy(options) {
  return serializeSpecification(releaseSpecification(options));
}

export function verifyReleaseContentSecurityPolicy(policy, options) {
  return verifySpecification(
    policy,
    releaseSpecification(options),
    "release Content-Security-Policy",
  );
}

/** 从 curl 的原始响应头中提取唯一一条 CSP；重复 header 不能由逗号合并后继续验收。 */
export function contentSecurityPolicyFromHeaders(rawHeaders) {
  if (typeof rawHeaders !== "string" || Buffer.byteLength(rawHeaders, "utf8") > MAXIMUM_HEADER_BYTES) {
    fail("HTTP response headers are missing or too large");
  }
  const policies = rawHeaders.split(/\r?\n/u)
    .filter((line) => /^content-security-policy:/iu.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
  if (policies.length !== 1 || policies[0] === "") {
    fail("HTTP response must contain exactly one Content-Security-Policy header");
  }
  return policies[0];
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(name)) {
      fail("usage: content-security-policy.mjs --rgs-base-url URL --host-origin ORIGIN");
    }
    values.set(name, value);
  }
  if (values.size !== 2 || !values.has("--rgs-base-url") || !values.has("--host-origin")) {
    fail("usage: content-security-policy.mjs --rgs-base-url URL --host-origin ORIGIN");
  }
  return {
    rgsBaseUrl: values.get("--rgs-base-url"),
    hostOrigin: values.get("--host-origin"),
  };
}

async function readStandardInput() {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source, "utf8") > MAXIMUM_HEADER_BYTES) {
      fail("HTTP response headers are missing or too large");
    }
  }
  return source;
}

async function main(argv) {
  const options = parseArguments(argv);
  const policy = contentSecurityPolicyFromHeaders(await readStandardInput());
  verifyReleaseContentSecurityPolicy(policy, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`CSP 响应门禁：${error instanceof Error ? error.message : "verification failed"}\n`);
    process.exitCode = 1;
  });
}
