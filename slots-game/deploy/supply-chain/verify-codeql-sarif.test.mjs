import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyCodeqlSarif } from "./verify-codeql-sarif.mjs";

function fixture({ results = [], rules = [] } = {}) {
  return {
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "CodeQL", rules } }, results }],
  };
}

function extensionFixture({ results = [], rules = [] } = {}) {
  return {
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "CodeQL" }, extensions: [{ name: "codeql/test-queries", rules }] },
      results,
    }],
  };
}

function withSarif(document, callback) {
  const directory = mkdtempSync(join(tmpdir(), "codeql-sarif-contract-"));
  try {
    const path = join(directory, "results.sarif");
    writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");
    callback(path, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("接受无 High/Critical 结果的 CodeQL SARIF", () => {
  const rules = [
    { id: "js/quality", properties: { tags: ["maintainability"] } },
    { id: "js/security-low", properties: { "security-severity": "6.9", tags: ["security"] } },
  ];
  const results = [{ ruleId: "js/quality" }, { ruleIndex: 1, ruleId: "js/security-low" }];
  withSarif(fixture({ rules, results }), (path) => {
    assert.deepEqual(verifyCodeqlSarif(path, 7), { blocked: 0, results: 2, threshold: 7 });
  });
});

test("拒绝 High/Critical CodeQL 结果", () => {
  for (const severity of ["7.0", "7.8", "9.3"]) {
    const rules = [{ id: "go/reflected-xss", properties: { "security-severity": severity, tags: ["security"] } }];
    withSarif(fixture({ rules, results: [{ ruleIndex: 0, ruleId: "go/reflected-xss" }] }), (path) => {
      assert.throws(() => verifyCodeqlSarif(path, 7), /found 1 result/);
    });
  }
});

test("解析 CodeQL 扩展组件中的真实 SARIF 规则引用", () => {
  const rules = [{ id: "js/bad-tag-filter", properties: { "security-severity": "7.8", tags: ["security"] } }];
  const results = [{
    ruleId: "js/bad-tag-filter",
    rule: { id: "js/bad-tag-filter", index: 0, toolComponent: { index: 0 } },
  }];
  withSarif(extensionFixture({ rules, results }), (path) => {
    assert.throws(() => verifyCodeqlSarif(path, 7), /js\/bad-tag-filter@7.8/);
  });
});

test("对缺失或损坏的安全元数据失败闭合", () => {
  const invalidRules = [
    { id: "missing", properties: { tags: ["security"] } },
    { id: "invalid", properties: { "security-severity": "high", tags: ["security"] } },
    { id: "range", properties: { "security-severity": 11, tags: ["security"] } },
  ];
  for (const rule of invalidRules) {
    withSarif(fixture({ rules: [rule], results: [{ ruleIndex: 0, ruleId: rule.id }] }), (path) => {
      assert.throws(() => verifyCodeqlSarif(path, 7), /security-severity/);
    });
  }
});

test("拒绝无 SARIF、损坏 JSON 与无法解析的规则引用", () => {
  const directory = mkdtempSync(join(tmpdir(), "codeql-sarif-contract-"));
  try {
    mkdirSync(join(directory, "empty"));
    assert.throws(() => verifyCodeqlSarif(join(directory, "empty"), 7), /contains no SARIF/);
    const invalid = join(directory, "invalid.sarif");
    writeFileSync(invalid, "{", "utf8");
    assert.throws(() => verifyCodeqlSarif(invalid, 7), /valid JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  withSarif(fixture({ rules: [], results: [{ ruleId: "missing" }] }), (path) => {
    assert.throws(() => verifyCodeqlSarif(path, 7), /resolve unambiguously/);
  });
});

test("拒绝无效阈值", () => {
  withSarif(fixture(), (path) => {
    for (const threshold of [Number.NaN, -1, 11]) {
      assert.throws(() => verifyCodeqlSarif(path, threshold), /threshold/);
    }
  });
});
