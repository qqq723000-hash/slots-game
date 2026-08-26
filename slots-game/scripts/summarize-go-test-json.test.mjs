import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = new URL("./summarize-go-test-json.mjs", import.meta.url);

function fixture(events, allowlist) {
  const directory = mkdtempSync(join(tmpdir(), "slots-go-summary-"));
  const eventsPath = join(directory, "events.jsonl");
  const allowlistPath = join(directory, "allowlist.txt");
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(allowlistPath, `${allowlist.join("\n")}\n`);
  return { eventsPath, allowlistPath };
}

test("只统计叶子测试并验证精确 skip allowlist", () => {
  const { eventsPath, allowlistPath } = fixture(
    [
      { Package: "example/pkg", Test: "TestParent/sub", Action: "pass" },
      { Package: "example/pkg", Test: "TestParent", Action: "pass" },
      { Package: "example/pkg", Test: "TestExternal", Action: "skip" },
    ],
    ["example/pkg\tTestExternal"],
  );
  const result = spawnSync(process.execPath, [scriptPath.pathname, eventsPath, allowlistPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    leaf_passed: 1,
    leaf_skipped: 1,
    skip_allowlist_verified: true,
  });
});

test("拒绝未批准的静默跳过", () => {
  const { eventsPath, allowlistPath } = fixture(
    [
      { Package: "example/pkg", Test: "TestPasses", Action: "pass" },
      { Package: "example/pkg", Test: "TestUnexpected", Action: "skip" },
    ],
    [],
  );
  const result = spawnSync(process.execPath, [scriptPath.pathname, eventsPath, allowlistPath], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /出现未批准跳过/u);
});
