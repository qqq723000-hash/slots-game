import assert from "node:assert/strict";
import test from "node:test";

import {
  PERSONAL_PROJECT_NOTICE,
  isMarkdownDocumentName,
  validateDocumentationContent,
  validateRepositoryReferenceContent,
} from "./verify-personal-project-docs.mjs";

const validDocument = `# 个人独立商用级交付\n\n${PERSONAL_PROJECT_NOTICE}\n\n技术正文。\n`;

test("accepts the canonical personal-independent notice", () => {
  assert.doesNotThrow(() => validateDocumentationContent("README.md", validDocument));
});

test("recognizes Markdown extensions without a case-sensitive bypass", () => {
  assert.equal(isMarkdownDocumentName("README.md"), true);
  assert.equal(isMarkdownDocumentName("RUNBOOK.MD"), true);
  assert.equal(isMarkdownDocumentName("README.md.bak"), false);
});

test("rejects a missing, duplicated, changed, or late notice", () => {
  assert.throws(
    () => validateDocumentationContent("missing.md", "# Missing\n"),
    /expected exactly one personal-independent project marker/u,
  );
  assert.throws(
    () => validateDocumentationContent("duplicate.md", `${validDocument}\n${PERSONAL_PROJECT_NOTICE}`),
    /expected exactly one personal-independent project marker/u,
  );
  assert.throws(
    () => validateDocumentationContent("changed.md", validDocument.replace("商用级源码", "普通源码")),
    /differs from the canonical wording/u,
  );
  assert.throws(
    () => validateDocumentationContent("late.md", `# Late\n${"x".repeat(1_201)}\n${PERSONAL_PROJECT_NOTICE}`),
    /must remain near the document title/u,
  );
});

test("rejects named-provider and legacy source wording variants", () => {
  const forbidden = [
    "Play'n GO",
    "Play’n Go",
    "playngo.com",
    "playngonetwork.com",
    "ContainerLauncher",
    "原游戏运行页",
    "原版画面",
    "live original",
    "Official PAYTABLE",
    "official-help-paytable.spec.md",
    "G'm GO",
  ];
  for (const value of forbidden) {
    assert.throws(
      () => validateDocumentationContent("forbidden.md", `${validDocument}\n${value}\n`),
      /contains /u,
      value,
    );
  }
});

test("rejects named-provider references outside Markdown by path or content", () => {
  assert.throws(
    () => validateRepositoryReferenceContent("web/src/example.ts", "const source = 'ContainerLauncher';"),
    /external launcher product name/u,
  );
  assert.throws(
    () => validateRepositoryReferenceContent("web/public/playngonetwork.com.json", "{}"),
    /contains (?:named external game provider|external provider domain)/u,
  );
  assert.throws(
    () => validateRepositoryReferenceContent("web/src/example.ts", "const brand = \"G'm GO\";"),
    /derivative provider label/u,
  );
  for (const path of [
    "web/public/assets/brand/powered-by-gm-go.png",
    "web/public/assets/brand/statusbar-gm-go.png",
  ]) {
    assert.throws(
      () => validateRepositoryReferenceContent(path, "binary asset placeholder"),
      /derivative provider label/u,
      path,
    );
  }
});

test("rejects wording that implies an existing company or internal delivery team", () => {
  const forbidden = [
    "面向公司正式交付",
    "公司生产集群",
    "企业落地区",
    "企业平台负责验收",
    "本公司负责发布",
    "our team owns production",
    "我们的团队负责生产发布",
    "本项目团队负责线上维护",
    "This repository is maintained by the company team.",
    "We operate this production service.",
    "平台团队负责部署",
    "安全团队负责审批",
    "运营商集成团队负责接入",
    "我们还要求重试确定性",
    "本方事务协调器",
  ];
  for (const value of forbidden) {
    assert.throws(
      () => validateDocumentationContent("identity.md", `${validDocument}\n${value}\n`),
      /contains /u,
      value,
    );
  }
});

test("allows the changelog to omit the notice without bypassing identity or reference rules", () => {
  assert.doesNotThrow(() =>
    validateDocumentationContent("slots-game/CHANGELOG.md", "# 变更记录\n\n历史正式集群表述。\n", {
      requireIdentityNotice: false,
    }),
  );
  assert.throws(
    () =>
      validateDocumentationContent("slots-game/CHANGELOG.md", "# 变更记录\n\n历史公司集群表述。\n", {
        requireIdentityNotice: false,
      }),
    /company-backed delivery wording/u,
  );
  assert.throws(
    () =>
      validateDocumentationContent("slots-game/CHANGELOG.md", "# 变更记录\n\nPlay'n GO\n", {
        requireIdentityNotice: false,
      }),
    /named external game provider/u,
  );
});
