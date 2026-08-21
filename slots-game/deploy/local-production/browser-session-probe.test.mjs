import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { browserSessionProbeSource } from "./browser-session-probe.mjs";

function executeProbe() {
  let violationListener;
  const storage = new Map();
  const context = {
    URL,
    URLSearchParams,
    location: {
      hash: "#rgsLaunchCode=lc_private&rgsOperatorId=operator-a&rgsSessionId=session-a",
      origin: "https://slots.localhost:8443",
    },
    sessionStorage: {
      getItem: (name) => storage.get(name) ?? null,
      removeItem: (name) => storage.delete(name),
      setItem: (name, value) => storage.set(name, value),
    },
    addEventListener: (name, listener) => {
      if (name === "securitypolicyviolation") violationListener = listener;
    },
  };
  runInNewContext(browserSessionProbeSource, context);
  return { context, violationListener };
}

test("探针只保留启动参数存在性并注册 CSP 违规监听", () => {
  const { context, violationListener } = executeProbe();
  assert.equal(typeof violationListener, "function");
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__localSessionProbe)),
    {
      hasLaunchCode: true,
      hasOperatorId: true,
      hasSessionId: true,
      cspViolations: [],
      storageWritable: true,
    },
  );
  assert.doesNotMatch(JSON.stringify(context.__localSessionProbe), /lc_private/u);
});

test("CSP 违规诊断只保留 origin 并限制数量", () => {
  const { context, violationListener } = executeProbe();
  violationListener({
    effectiveDirective: "script-src-elem",
    violatedDirective: "script-src-elem",
    disposition: "enforce",
    blockedURI: "https://invalid.example/script.js?accessToken=private#launch",
  });
  for (let index = 0; index < 20; index += 1) {
    violationListener({
      effectiveDirective: "script-src",
      violatedDirective: "script-src",
      disposition: "enforce",
      blockedURI: "eval",
    });
  }
  const violations = context.__localSessionProbe.cspViolations;
  assert.equal(violations.length, 16);
  assert.equal(violations[0].blockedTarget, "https://invalid.example");
  assert.equal(violations[1].blockedTarget, "eval");
  assert.doesNotMatch(JSON.stringify(violations), /accessToken|private|#launch/u);
});
