#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const maximumSarifBytes = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(`CodeQL SARIF contract: ${message}`);
}

function sarifFiles(inputPath) {
  const resolved = resolve(inputPath);
  const info = lstatSync(resolved);
  if (info.isSymbolicLink()) fail("input must not be a symbolic link");
  if (info.isFile()) return [resolved];
  if (!info.isDirectory()) fail("input must be a regular SARIF file or directory");
  const files = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() &&
      (entry.name.endsWith(".sarif") || entry.name.endsWith(".sarif.json")))
    .map((entry) => resolve(resolved, entry.name))
    .sort();
  if (files.length === 0) fail("input directory contains no SARIF files");
  return files;
}

function parseSarif(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumSarifBytes) {
    fail("each SARIF input must be a non-empty bounded regular file");
  }
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("SARIF input must contain valid JSON");
  }
  if (document?.version !== "2.1.0" || !Array.isArray(document.runs) || document.runs.length === 0) {
    fail("input must be SARIF 2.1.0 with at least one run");
  }
  return document;
}

function ruleSecuritySeverity(rule) {
  const properties = rule?.properties;
  const raw = properties?.["security-severity"];
  const tags = Array.isArray(properties?.tags) ? properties.tags : [];
  const securityRule = tags.some((tag) => tag === "security" || tag.startsWith("external/cwe/"));
  if (raw === undefined || raw === null || raw === "") {
    if (securityRule) fail(`security rule ${rule?.id ?? "<unknown>"} is missing security-severity`);
    return null;
  }
  const severity = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(severity) || severity < 0 || severity > 10) {
    fail(`rule ${rule?.id ?? "<unknown>"} has an invalid security-severity`);
  }
  return severity;
}

export function verifyCodeqlSarif(inputPath, threshold = 7) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 10) {
    fail("threshold must be a finite number from 0 through 10");
  }
  let results = 0;
  const blocked = [];
  for (const path of sarifFiles(inputPath)) {
    const document = parseSarif(path);
    for (const run of document.runs) {
      const driver = run?.tool?.driver;
      const extensions = run?.tool?.extensions ?? [];
      if (!driver || !Array.isArray(extensions) || !Array.isArray(run.results)) {
        fail("every run must contain a tool driver, optional extensions, and a results array");
      }
      const components = [driver, ...extensions];
      const componentRules = components.map((component) => component.rules ?? []);
      const componentRulesByID = componentRules.map((rules) => {
        if (!Array.isArray(rules)) fail("tool component rules must be arrays when present");
        const rulesByID = new Map();
        for (const rule of rules) {
          if (typeof rule?.id !== "string" || rule.id === "" || rulesByID.has(rule.id)) {
            fail("tool component rules must have unique non-empty IDs");
          }
          rulesByID.set(rule.id, rule);
        }
        return rulesByID;
      });
      for (const result of run.results) {
        results += 1;
        const extensionIndex = result?.rule?.toolComponent?.index;
        const componentIndex = Number.isInteger(extensionIndex) ? extensionIndex + 1 : 0;
        if (componentIndex < 0 || componentIndex >= components.length) {
          fail("result references an unknown tool extension");
        }
        const ruleIndex = Number.isInteger(result?.rule?.index) ? result.rule.index : result?.ruleIndex;
        const ruleID = result?.rule?.id ?? result?.ruleId;
        const indexedRule = Number.isInteger(ruleIndex) ? componentRules[componentIndex][ruleIndex] : undefined;
        const identifiedRule = typeof ruleID === "string" ? componentRulesByID[componentIndex].get(ruleID) : undefined;
        let rule = indexedRule ?? identifiedRule;
        if (!rule && !Number.isInteger(extensionIndex) && typeof ruleID === "string") {
          const matches = componentRulesByID.flatMap((rulesByID) => {
            const match = rulesByID.get(ruleID);
            return match ? [match] : [];
          });
          if (matches.length === 1) rule = matches[0];
        }
        if (!rule || (identifiedRule && indexedRule && identifiedRule !== indexedRule) ||
          (typeof ruleID === "string" && rule.id !== ruleID)) {
          fail("every result must resolve unambiguously to a driver rule");
        }
        const severity = ruleSecuritySeverity(rule);
        if (severity !== null && severity >= threshold) {
          blocked.push(`${rule.id}@${severity}`);
        }
      }
    }
  }
  if (blocked.length > 0) {
    fail(`found ${blocked.length} result(s) at or above ${threshold}: ${blocked.join(", ")}`);
  }
  return { blocked: 0, results, threshold };
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  if (process.argv.length !== 3 && process.argv.length !== 4) {
    fail("usage: verify-codeql-sarif.mjs SARIF_FILE_OR_DIRECTORY [THRESHOLD]");
  }
  const threshold = process.argv[3] === undefined ? 7 : Number(process.argv[3]);
  const result = verifyCodeqlSarif(process.argv[2], threshold);
  process.stdout.write(
    `CodeQL SARIF contract: ${result.results} result(s), none at or above ${result.threshold}\n`,
  );
}
