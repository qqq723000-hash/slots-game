import assert from "node:assert/strict";
import test from "node:test";

import { splitHtmlCommentEnd } from "./verify-chinese-comments.mjs";

test("HTML 注释结束符按最早位置截断", () => {
  const cases = [
    ["English only -->中文", { body: "English only ", ended: true }],
    ["English only --!>中文", { body: "English only ", ended: true }],
    ["English only -->\r中文", { body: "English only ", ended: true }],
    ["English only -->\u2028中文", { body: "English only ", ended: true }],
    ["English only -->\u2029中文", { body: "English only ", ended: true }],
    ["--!>ignored -->", { body: "", ended: true }],
    ["English only", { body: "English only", ended: false }],
  ];
  for (const [value, expected] of cases) {
    assert.deepEqual(splitHtmlCommentEnd(value), expected);
  }
});
