import assert from "node:assert/strict";
import test from "node:test";

import {
  collectHumanCommentBlocks,
  findBilingualCommentViolations,
  hasSubstantiveEnglishComment,
  splitHtmlCommentEnd,
} from "./verify-chinese-comments.mjs";

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

test("相邻单行与块注释按语义块接受中英双语", () => {
  const source = `// 中文约束说明。\n// This comment explains a real constraint.\nconst value = true;\n\n/**\n * 中文块说明。\n * This block explains another constraint.\n */\nexport { value };\n`;
  assert.deepEqual(collectHumanCommentBlocks("example.ts", source), [
    {
      line: 1,
      text: "中文约束说明。\nThis comment explains a real constraint.",
    },
    {
      line: 5,
      text: "中文块说明。\nThis block explains another constraint.",
    },
  ]);
  assert.deepEqual(findBilingualCommentViolations("example.ts", source), []);
});

test("分别拒绝缺少中文或英文的人工注释块", () => {
  const source = `// 只有中文说明。\nconst first = true;\n// English only explanation.\nconst second = true;\n`;
  assert.deepEqual(
    findBilingualCommentViolations("example.ts", source).map(({ line, missing }) => ({ line, missing })),
    [
      { line: 1, missing: "English" },
      { line: 3, missing: "Chinese" },
    ],
  );
});

test("协议标识符不能冒充英文说明", () => {
  assert.equal(hasSubstantiveEnglishComment("钱包保留 `WALLET_PENDING` 与 operationId。"), false);
  assert.equal(
    hasSubstantiveEnglishComment("钱包保留待定状态。 English: Keep the pending state."),
    true,
  );
});

test("机器指令不属于人工双语注释", () => {
  const source = `#!/bin/sh\n# shellcheck disable=SC2086\n// go:build integration\n`;
  assert.deepEqual(findBilingualCommentViolations("example.sh", source), []);
});

test("Shell heredoc 载荷中的井号文本不按源码注释检查", () => {
  const source = `#!/bin/sh
# heredoc 前的真实中文注释。
cat <<'CONFIG' >output.conf
# 这是配置载荷，不是 Shell 源码注释。
value=true
CONFIG
# This is a real English-only source comment.
`;
  assert.deepEqual(
    findBilingualCommentViolations("example.sh", source).map(({ line, missing }) => ({ line, missing })),
    [
      { line: 2, missing: "English" },
      { line: 7, missing: "Chinese" },
    ],
  );
});

test("Shell heredoc 只跳过载荷并支持 tab 剥离与多个定界符", () => {
  const source = `cat <<-FIRST <<"SECOND"
\t# 第一个载荷。
\tFIRST
# second payload text
SECOND
# 中文真实注释。 / English: This remains a real source comment.
`;
  assert.deepEqual(findBilingualCommentViolations("example.sh", source), []);
});

test("Shell 注释和引号中的 heredoc 字样不会开启载荷跳过", () => {
  const source = `# 真实中文注释提到 <<EOF。
value='literal <<SKIP'
# Another real English-only source comment.
`;
  assert.deepEqual(
    findBilingualCommentViolations("example.sh", source).map(({ line, missing }) => ({ line, missing })),
    [
      { line: 1, missing: "English" },
      { line: 3, missing: "Chinese" },
    ],
  );
});

test("Terraform 的井号、双斜线与块注释共享双语规则", () => {
  const source = `# 中文井号说明。\n# This hash comment explains the constraint.\nresource "x" "y" {}\n// 中文双斜线说明。\n// This slash comment explains the constraint.\n/* 中文块说明。\n * This block comment explains the constraint.\n */\n`;
  assert.deepEqual(findBilingualCommentViolations("example.tf", source), []);
});
