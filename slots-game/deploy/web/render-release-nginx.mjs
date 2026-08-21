#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  createReleaseContentSecurityPolicy,
  verifyBaseContentSecurityPolicy,
  verifyReleaseContentSecurityPolicy,
} from "./content-security-policy.mjs";

const CSP_HEADER = /^[\t ]*add_header[\t ]+Content-Security-Policy[\t ]+"([^"\r\n]*)"[\t ]+always;[\t ]*$/gim;
const X_FRAME_HEADER = /^[\t ]*add_header[\t ]+X-Frame-Options[\t ]+"?([^";\r\n]+)"?[\t ]+always;[\t ]*$/gim;

function onlyMatch(source, expression, label) {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    throw new Error(`base nginx config must contain exactly one ${label}`);
  }
  return matches[0];
}

/**
 * 生产 RGS iframe 的响应策略必须与同一次构建的两个公开 origin 完全一致。
 * 这里只接受规范 HTTPS 值并做单点替换，禁止用通配符或运行时字符串拼接放宽 CSP。
 */
export function renderReleaseNginxConfig(baseConfig, options) {
  const frameHeader = onlyMatch(baseConfig, X_FRAME_HEADER, "X-Frame-Options header");
  if (frameHeader[1]?.trim().toUpperCase() !== "SAMEORIGIN") {
    throw new Error("base X-Frame-Options header must be SAMEORIGIN");
  }
  const cspHeader = onlyMatch(baseConfig, CSP_HEADER, "Content-Security-Policy header");
  verifyBaseContentSecurityPolicy(cspHeader[1]);
  const renderedPolicy = createReleaseContentSecurityPolicy(options);
  verifyReleaseContentSecurityPolicy(renderedPolicy, options);
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
