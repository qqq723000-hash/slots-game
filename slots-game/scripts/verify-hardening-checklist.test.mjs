import assert from "node:assert/strict";
import test from "node:test";

import {
  HARDENING_CHECKLIST_SECTIONS,
  HARDENING_CHECKLIST_TITLE,
  validateHardeningChecklist,
} from "./verify-hardening-checklist.mjs";
import { PERSONAL_PROJECT_NOTICE } from "./verify-personal-project-docs.mjs";

function fixture(itemsPerSection = 1) {
  const lines = [HARDENING_CHECKLIST_TITLE, ""];
  for (const [sectionIndex, section] of HARDENING_CHECKLIST_SECTIONS.entries()) {
    lines.push(`## ${section}`, "");
    for (let itemIndex = 0; itemIndex < itemsPerSection; itemIndex += 1) {
      lines.push(`- 契约名称 ${sectionIndex + 1}-${itemIndex + 1}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

test("accepts the exact ordered section topology and names-only entries", () => {
  const source = fixture(2);
  assert.deepEqual(
    validateHardeningChecklist(source, { minimumItems: HARDENING_CHECKLIST_SECTIONS.length * 2 }),
    { sections: HARDENING_CHECKLIST_SECTIONS.length, items: HARDENING_CHECKLIST_SECTIONS.length * 2 },
  );
  const withPersonalProjectNotice = source.replace(
    `${HARDENING_CHECKLIST_TITLE}\n\n`,
    `${HARDENING_CHECKLIST_TITLE}\n\n${PERSONAL_PROJECT_NOTICE}\n\n`,
  );
  assert.deepEqual(
    validateHardeningChecklist(withPersonalProjectNotice, {
      minimumItems: HARDENING_CHECKLIST_SECTIONS.length * 2,
    }),
    { sections: HARDENING_CHECKLIST_SECTIONS.length, items: HARDENING_CHECKLIST_SECTIONS.length * 2 },
  );
});

test("rejects prose, duplicate names, reordered sections, and a truncated baseline", () => {
  const valid = fixture();
  const firstItem = "- 契约名称 1-1";
  const secondItem = "- 契约名称 2-1";
  const firstSection = `## ${HARDENING_CHECKLIST_SECTIONS[0]}`;
  const secondSection = `## ${HARDENING_CHECKLIST_SECTIONS[1]}`;

  assert.throws(
    () => validateHardeningChecklist(valid.replace(firstItem, "这是一段说明文字。"), { minimumItems: 1 }),
    /不是名称条目/u,
  );
  assert.throws(
    () => validateHardeningChecklist(valid.replace(secondItem, firstItem), { minimumItems: 1 }),
    /重复名称/u,
  );
  assert.throws(
    () => validateHardeningChecklist(
      valid.replace(firstSection, "## 临时占位").replace(secondSection, firstSection)
        .replace("## 临时占位", secondSection),
      { minimumItems: 1 },
    ),
    /分组缺失、顺序漂移/u,
  );
  assert.throws(
    () => validateHardeningChecklist(valid, { minimumItems: HARDENING_CHECKLIST_SECTIONS.length + 1 }),
    /低于最低基线/u,
  );
});

test("rejects sentence punctuation, CRLF, BOM, and overlong names", () => {
  const valid = fixture();
  assert.throws(
    () => validateHardeningChecklist(valid.replace("- 契约名称 1-1", "- 这是说明。"), { minimumItems: 1 }),
    /说明句/u,
  );
  assert.throws(
    () => validateHardeningChecklist(valid.replaceAll("\n", "\r\n"), { minimumItems: 1 }),
    /LF UTF-8/u,
  );
  assert.throws(
    () => validateHardeningChecklist(`\uFEFF${valid}`, { minimumItems: 1 }),
    /LF UTF-8/u,
  );
  assert.throws(
    () => validateHardeningChecklist(
      valid.replace("- 契约名称 1-1", `- ${"长".repeat(97)}`),
      { minimumItems: 1 },
    ),
    /过长/u,
  );
});
