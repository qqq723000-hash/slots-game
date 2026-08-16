#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CSP_HEADER = /^[\t ]*add_header[\t ]+Content-Security-Policy[\t ]+"([^"\r\n]*)"[\t ]+always;[\t ]*$/gim;
const X_FRAME_HEADER = /^[\t ]*add_header[\t ]+X-Frame-Options[\t ]+"?([^";\r\n]+)"?[\t ]+always;[\t ]*$/gim;

function exactHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an exact credential-free HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
    || parsed.origin !== value) {
    throw new Error(`${label} must be an exact credential-free HTTPS origin`);
  }
  return parsed.origin;
}

function rgsHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("RGS base URL must be a credential-free HTTPS origin/path");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("RGS base URL must be a credential-free HTTPS origin/path");
  }
  return parsed.origin;
}

function onlyMatch(source, expression, label) {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    throw new Error(`base nginx config must contain exactly one ${label}`);
  }
  return matches[0];
}

function parsePolicy(policy) {
  if (policy.includes("\\")) {
    throw new Error("base Content-Security-Policy must not use escaped dynamic text");
  }
  const directives = policy.split(";").map((value) => value.trim()).filter(Boolean);
  const names = new Set();
  const parsed = directives.map((directive) => {
    const [name, ...sources] = directive.split(/\s+/u);
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {
      throw new Error(`base Content-Security-Policy contains duplicate ${normalized}`);
    }
    names.add(normalized);
    return { name: normalized, sources };
  });
  const connect = parsed.find((directive) => directive.name === "connect-src");
  const frames = parsed.find((directive) => directive.name === "frame-ancestors");
  if (!connect || connect.sources.length !== 1 || connect.sources[0] !== "'self'") {
    throw new Error("base Content-Security-Policy must contain one exact connect-src 'self'");
  }
  if (!frames || frames.sources.length !== 1 || frames.sources[0] !== "'self'") {
    throw new Error("base Content-Security-Policy must contain one exact frame-ancestors 'self'");
  }
  return parsed;
}

/**
 * 生产 RGS iframe 的响应策略必须与同一次构建的两个公开 origin 完全一致。
 * 这里只接受规范 HTTPS 值并做单点替换，禁止用通配符或运行时字符串拼接放宽 CSP。
 */
export function renderReleaseNginxConfig(baseConfig, options) {
  const hostOrigin = exactHttpsOrigin(options?.hostOrigin, "operator host origin");
  const rgsOrigin = rgsHttpsOrigin(options?.rgsBaseUrl);
  const frameHeader = onlyMatch(baseConfig, X_FRAME_HEADER, "X-Frame-Options header");
  if (frameHeader[1]?.trim().toUpperCase() !== "SAMEORIGIN") {
    throw new Error("base X-Frame-Options header must be SAMEORIGIN");
  }
  const cspHeader = onlyMatch(baseConfig, CSP_HEADER, "Content-Security-Policy header");
  const directives = parsePolicy(cspHeader[1]);
  const renderedPolicy = directives.map((directive) => {
    if (directive.name === "connect-src") return `connect-src 'self' ${rgsOrigin}`;
    if (directive.name === "frame-ancestors") return `frame-ancestors ${hostOrigin}`;
    return [directive.name, ...directive.sources].join(" ");
  }).join("; ");
  let rendered = baseConfig.slice(0, frameHeader.index)
    + "  # 跨源 release 仅依赖精确 CSP 父页面限制；禁止回退到 ALLOW-FROM 或通配符。"
    + baseConfig.slice(frameHeader.index + frameHeader[0].length);
  const renderedCspMatch = onlyMatch(rendered, CSP_HEADER, "Content-Security-Policy header");
  rendered = rendered.slice(0, renderedCspMatch.index)
    + `  add_header Content-Security-Policy "${renderedPolicy}" always;`
    + rendered.slice(renderedCspMatch.index + renderedCspMatch[0].length);
  if ([...rendered.matchAll(X_FRAME_HEADER)].length !== 0
    || [...rendered.matchAll(CSP_HEADER)].length !== 1) {
    throw new Error("rendered release nginx policy is not exact-origin only");
  }
  return rendered;
}

function argumentsFor(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(
        "usage: render-release-nginx.mjs --input FILE --output FILE --rgs-base-url URL --host-origin ORIGIN",
      );
    }
    if (result.has(name)) throw new Error(`duplicate argument ${name}`);
    result.set(name, value);
  }
  return result;
}

async function main(argv) {
  const values = argumentsFor(argv);
  const input = values.get("--input");
  const output = values.get("--output");
  const rgsBaseUrl = values.get("--rgs-base-url");
  const hostOrigin = values.get("--host-origin");
  if (!input || !output || !rgsBaseUrl || !hostOrigin || values.size !== 4) {
    throw new Error(
      "usage: render-release-nginx.mjs --input FILE --output FILE --rgs-base-url URL --host-origin ORIGIN",
    );
  }
  const baseConfig = await readFile(input, "utf8");
  const rendered = renderReleaseNginxConfig(baseConfig, { rgsBaseUrl, hostOrigin });
  const temporaryOutput = `${output}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryOutput, rendered, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporaryOutput, output);
  } catch (error) {
    await unlink(temporaryOutput).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "release nginx render failed"}\n`);
    process.exitCode = 1;
  });
}
