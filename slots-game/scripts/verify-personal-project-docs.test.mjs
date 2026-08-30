import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  PERSONAL_PROJECT_NOTICE,
  hasSubstantiveChineseDocumentation,
  hasSubstantiveEnglishDocumentation,
  isMarkdownDocumentName,
  validateDocumentationContent,
  validateRepositoryReferenceContent,
  verifyPersonalProjectDocumentation,
} from "./verify-personal-project-docs.mjs";

const execFileAsync = promisify(execFile);

const chineseBody = "本文解释项目的服务端权威边界、失败关闭约束、验证证据以及必须由采用方在目标环境完成的外部门禁。";
const englishBody = "This document explains the server-authoritative boundary, fail-closed constraints, repository verification evidence, and the external deployment, operator, security, and regulatory gates that an adopter must complete.";
const validDocument = `# 个人独立商用级交付 / Independent delivery\n\n${PERSONAL_PROJECT_NOTICE}\n\n${chineseBody}\n\n## English summary / 英文摘要\n\n${englishBody}\n`;
const validChangelog = `# 变更记录 / Changelog\n\n${chineseBody}\n\n## English summary / 英文摘要\n\n${englishBody}\n`;

async function createGitFixture(context) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "slots-personal-docs-"));
  const repositoryRoot = join(fixtureRoot, "repository");
  const outsideRoot = join(fixtureRoot, "outside");
  context.after(async () => rm(fixtureRoot, { force: true, recursive: true }));
  await mkdir(repositoryRoot);
  await mkdir(outsideRoot);
  await execFileAsync("git", ["init", "--quiet", repositoryRoot]);
  await writeFile(join(repositoryRoot, "README.md"), validDocument);
  await execFileAsync("git", ["-C", repositoryRoot, "add", "README.md"]);
  return { outsideRoot, repositoryRoot };
}

test("accepts the canonical personal-independent notice", () => {
  assert.doesNotThrow(() => validateDocumentationContent("README.md", validDocument));
  assert.equal(hasSubstantiveChineseDocumentation(validDocument), true);
  assert.equal(hasSubstantiveEnglishDocumentation(validDocument), true);
});

test("rejects a notice-only translation or a missing English explanation", () => {
  assert.throws(
    () => validateDocumentationContent("chinese-only.md", `# 中文文档\n\n${PERSONAL_PROJECT_NOTICE}\n\n${chineseBody}\n`),
    /substantive English documentation is missing/u,
  );
  assert.throws(
    () => validateDocumentationContent(
      "english-only.md",
      `# English document\n\n${PERSONAL_PROJECT_NOTICE}\n\n${englishBody}\n`,
    ),
    /substantive Chinese documentation is missing/u,
  );
});

test("does not count closed or unterminated multiline HTML comments as documentation", () => {
  const chineseOnlyDocument = `# 中文文档\n\n${PERSONAL_PROJECT_NOTICE}\n\n${chineseBody}\n`;
  const englishOnlyDocument = `# English document\n\n${PERSONAL_PROJECT_NOTICE}\n\n${englishBody}\n`;

  for (const hiddenEnglish of [
    `<!--\nmetadata\n\n${englishBody}\n-->`,
    `<!--\n${englishBody}`,
  ]) {
    const document = `${chineseOnlyDocument}\n${hiddenEnglish}\n`;
    assert.equal(hasSubstantiveEnglishDocumentation(document), false);
    assert.throws(
      () => validateDocumentationContent("hidden-english.md", document),
      /substantive English documentation is missing/u,
    );
  }

  for (const hiddenChinese of [
    `<!--\nmetadata\n\n${chineseBody}\n-->`,
    `<!--\n${chineseBody}`,
  ]) {
    const document = `${englishOnlyDocument}\n${hiddenChinese}\n`;
    assert.equal(hasSubstantiveChineseDocumentation(document), false);
    assert.throws(
      () => validateDocumentationContent("hidden-chinese.md", document),
      /substantive Chinese documentation is missing/u,
    );
  }

  const visibleAfterComment = `${chineseOnlyDocument}\n<!--\nmetadata\n\nignored\n-->\n\n${englishBody}\n`;
  assert.equal(hasSubstantiveEnglishDocumentation(visibleAfterComment), true);
  assert.doesNotThrow(() => validateDocumentationContent("visible-after-comment.md", visibleAfterComment));
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
    validateDocumentationContent("slots-game/CHANGELOG.md", validChangelog, {
      requireIdentityNotice: false,
    }),
  );
  assert.throws(
    () =>
      validateDocumentationContent("slots-game/CHANGELOG.md", `${validChangelog}\n历史公司集群表述。\n`, {
        requireIdentityNotice: false,
      }),
    /company-backed delivery wording/u,
  );
  assert.throws(
    () =>
      validateDocumentationContent("slots-game/CHANGELOG.md", `${validChangelog}\nPlay'n GO\n`, {
        requireIdentityNotice: false,
      }),
    /named external game provider/u,
  );
});

test("only validates Git-tracked documentation and repository text", async (context) => {
  const { repositoryRoot } = await createGitFixture(context);
  await writeFile(join(repositoryRoot, "tracked.ts"), "export const safe = true;\n");
  await writeFile(join(repositoryRoot, "private-notes.md"), "# Untracked private notes\n");
  await writeFile(
    join(repositoryRoot, "untracked.ts"),
    "export const unrelated = 'ContainerLauncher';\n",
  );
  await execFileAsync("git", ["-C", repositoryRoot, "add", "tracked.ts"]);

  const result = await verifyPersonalProjectDocumentation(repositoryRoot, {
    minimumIdentityDocuments: 1,
  });
  assert.deepEqual(result.identityDocuments, ["README.md"]);
  assert.deepEqual(
    result.repositoryTextFiles.map(({ documentId }) => documentId),
    ["README.md", "tracked.ts"],
  );
});

test("validates provider-named binary paths inside every formerly ignored directory", async (context) => {
  const formerlyIgnoredDirectories = [".artifacts", "coverage", "dist", "node_modules", "output"];
  for (const directory of formerlyIgnoredDirectories) {
    await context.test(directory, async (subtest) => {
      const { repositoryRoot } = await createGitFixture(subtest);
      const binaryDirectory = join(repositoryRoot, directory);
      const binaryPath = join(binaryDirectory, "playngo.com.png");
      await mkdir(binaryDirectory, { recursive: true });
      await writeFile(binaryPath, Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]));
      await execFileAsync("git", ["-C", repositoryRoot, "add", "-f", "--", `${directory}/playngo.com.png`]);

      await assert.rejects(
        verifyPersonalProjectDocumentation(repositoryRoot, { minimumIdentityDocuments: 1 }),
        /contains (?:named external game provider|external provider domain)/u,
      );
    });
  }
});

test("rejects a tracked file reached through a parent-directory symlink", async (context) => {
  const { outsideRoot, repositoryRoot } = await createGitFixture(context);
  const trackedDirectory = join(repositoryRoot, "tracked-directory");
  await mkdir(trackedDirectory);
  await writeFile(join(trackedDirectory, "tracked.ts"), "export const safe = true;\n");
  await execFileAsync("git", ["-C", repositoryRoot, "add", "tracked-directory/tracked.ts"]);
  await rm(trackedDirectory, { recursive: true });
  await writeFile(join(outsideRoot, "tracked.ts"), "export const outside = true;\n");
  await symlink(outsideRoot, trackedDirectory, "dir");

  await assert.rejects(
    verifyPersonalProjectDocumentation(repositoryRoot, { minimumIdentityDocuments: 1 }),
    /tracked repository path component is a symbolic link: tracked-directory\/tracked\.ts/u,
  );
});

test("rejects every tracked file symlink, including a non-text asset", async (context) => {
  const { outsideRoot, repositoryRoot } = await createGitFixture(context);
  const outsideAsset = join(outsideRoot, "asset.bin");
  const trackedAsset = join(repositoryRoot, "asset.bin");
  await writeFile(outsideAsset, Buffer.from([0x00, 0x01, 0x02]));
  await symlink(outsideAsset, trackedAsset, "file");
  await execFileAsync("git", ["-C", repositoryRoot, "add", "asset.bin"]);

  await assert.rejects(
    verifyPersonalProjectDocumentation(repositoryRoot, { minimumIdentityDocuments: 1 }),
    /tracked repository path component is a symbolic link: asset\.bin/u,
  );
});
