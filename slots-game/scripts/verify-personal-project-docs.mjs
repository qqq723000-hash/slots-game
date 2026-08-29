import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PERSONAL_PROJECT_NOTICE = `<!-- personal-independent-project -->
> **个人独立项目说明：** 本仓库的工程实现与交付文档由个人独立开发者维护，并按商用级源码交付标准建设。
> 文中的生产、运营、平台、安全、审计、法务、合规与审批角色均为采用方在外部环境中需要落实的职责；
> 仓库内容不代表已上线或已获得服务等级、商业授权、素材授权或监管认证，第三方组件与素材仍受各自许可和权利边界约束。`;

const NOTICE_MARKER = "<!-- personal-independent-project -->";
const MINIMUM_IDENTITY_DOCUMENTS = 51;
const IDENTITY_NOTICE_EXCLUSIONS = new Set([
  "slots-game/CHANGELOG.md",
]);
const IGNORED_DIRECTORIES = new Set([
  ".artifacts",
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "output",
]);
const REPOSITORY_REFERENCE_SCAN_EXCLUSIONS = new Set([
  "slots-game/scripts/verify-personal-project-docs.mjs",
  "slots-game/scripts/verify-personal-project-docs.test.mjs",
  // These two files implement and negatively test the production-manifest brand guard itself.
  "slots-game/web/scripts/generate-streaming-package-manifests.mjs",
  "slots-game/web/tests/streaming-package-manifests.test.ts",
]);
const REPOSITORY_TEXT_FILE_PATTERN = /(?:^|\/)(?:Dockerfile|Makefile)$|\.(?:c?js|mjs|ts|tsx|go|rb|sh|sql|tf|toml|ya?ml|json|html|css|scss|md|txt|xml)$/iu;

const FORBIDDEN_REFERENCES = [
  { label: "named external game provider", pattern: /play\s*(?:['’‘`-]\s*)?n\s*(?:['’‘`-]\s*)?go/iu },
  { label: "external provider domain", pattern: /playngo(?:network)?\.com/iu },
  { label: "external launcher product name", pattern: /ContainerLauncher/u },
  { label: "legacy original-game wording", pattern: /原游戏/u },
  { label: "legacy original-version wording", pattern: /原版(?!本)/u },
  { label: "legacy live-original wording", pattern: /\blive original\b/iu },
  { label: "legacy official paytable wording", pattern: /Official PAYTABLE/iu },
  { label: "legacy official paytable path", pattern: /official-help-paytable/iu },
  { label: "derivative provider label", pattern: /\bg\s*['’]?\s*m(?:[\s_-]+)go\b/iu },
];

const FORBIDDEN_REPOSITORY_REFERENCES = FORBIDDEN_REFERENCES;

const FORBIDDEN_PROJECT_IDENTITY = [
  {
    label: "company-backed delivery wording",
    pattern: /面向公司正式交付|公司(?:生产|集群|平台|节点|审核|批准|服务|网络|告警|证书|发布)/u,
  },
  {
    label: "implied internal team wording",
    pattern: /企业落地区|企业平台|本(?:公司|团队|组织)|我们(?:的)?团队|本项目团队|(?:应用|平台|安全|数据库|网络|运营商集成)团队|SRE\/值班团队|\bour\s+(?:company|team|organization)\b/iu,
  },
  { label: "collective author voice", pattern: /我们还要求|本方事务协调器/u },
  {
    label: "company or collective maintenance claim",
    pattern: /由(?:本|该)?公司[^。\n]{0,80}(?:维护|开发|发布|运营)|maintained by (?:the|our) (?:company|team)|\bwe (?:maintain|operate|develop|release)\b/iu,
  },
];

function countOccurrences(content, needle) {
  return content.split(needle).length - 1;
}

export function validateDocumentationContent(documentId, content, { requireIdentityNotice = true } = {}) {
  if (requireIdentityNotice) {
    const markerCount = countOccurrences(content, NOTICE_MARKER);
    if (markerCount !== 1) {
      throw new Error(`${documentId}: expected exactly one personal-independent project marker, found ${markerCount}`);
    }
    const noticeOffset = content.indexOf(PERSONAL_PROJECT_NOTICE);
    if (noticeOffset < 0) {
      throw new Error(`${documentId}: personal-independent project notice differs from the canonical wording`);
    }
    if (noticeOffset > 1_200) {
      throw new Error(`${documentId}: personal-independent project notice must remain near the document title`);
    }
  }

  for (const rule of FORBIDDEN_REFERENCES) {
    if (rule.pattern.test(content)) {
      throw new Error(`${documentId}: contains ${rule.label}`);
    }
  }

  for (const rule of FORBIDDEN_PROJECT_IDENTITY) {
    if (rule.pattern.test(content)) {
      throw new Error(`${documentId}: contains ${rule.label}`);
    }
  }
}

export function isMarkdownDocumentName(name) {
  return name.toLowerCase().endsWith(".md");
}

async function collectMarkdownFiles(directory, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.isSymbolicLink() && isMarkdownDocumentName(entry.name)) {
      throw new Error(`documentation symlink is not allowed: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await collectMarkdownFiles(entryPath, files);
    } else if (entry.isFile() && isMarkdownDocumentName(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function collectRepositoryTextFiles(directory, deliveryRoot, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectRepositoryTextFiles(entryPath, deliveryRoot, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const documentId = relative(deliveryRoot, entryPath).split(sep).join("/");
    // Validate every regular-file path before deciding whether its bytes are safe to decode as text.
    // This closes the binary-filename bypass for forbidden provider assets such as PNG files.
    validateRepositoryReferenceContent(documentId, "");
    if (
      REPOSITORY_REFERENCE_SCAN_EXCLUSIONS.has(documentId)
      || !REPOSITORY_TEXT_FILE_PATTERN.test(documentId)
    ) continue;
    files.push({ documentId, entryPath });
  }
  return files;
}

export function validateRepositoryReferenceContent(documentId, content) {
  for (const rule of FORBIDDEN_REPOSITORY_REFERENCES) {
    if (rule.pattern.test(documentId) || rule.pattern.test(content)) {
      throw new Error(`${documentId}: contains ${rule.label}`);
    }
  }
}

export async function verifyPersonalProjectDocumentation(deliveryRoot) {
  const markdownFiles = await collectMarkdownFiles(deliveryRoot);
  const identityDocuments = [];

  for (const documentPath of markdownFiles.sort()) {
    const documentId = relative(deliveryRoot, documentPath).split(sep).join("/");
    const requireIdentityNotice = !IDENTITY_NOTICE_EXCLUSIONS.has(documentId);
    const content = await readFile(documentPath, "utf8");
    validateDocumentationContent(documentId, content, { requireIdentityNotice });
    if (requireIdentityNotice) identityDocuments.push(documentId);
  }

  if (identityDocuments.length < MINIMUM_IDENTITY_DOCUMENTS) {
    throw new Error(
      `personal-independent documentation coverage regressed: expected at least ${MINIMUM_IDENTITY_DOCUMENTS}, found ${identityDocuments.length}`,
    );
  }

  const repositoryTextFiles = await collectRepositoryTextFiles(deliveryRoot, deliveryRoot);
  for (const { documentId, entryPath } of repositoryTextFiles) {
    validateRepositoryReferenceContent(documentId, await readFile(entryPath, "utf8"));
  }

  return { identityDocuments, markdownFiles, repositoryTextFiles };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const projectRoot = resolve(dirname(scriptPath), "..");
  const deliveryRoot = resolve(projectRoot, "..");
  const result = await verifyPersonalProjectDocumentation(deliveryRoot);
  process.stdout.write(
    `Verified ${result.identityDocuments.length} personal-independent project documents; scanned ${result.markdownFiles.length} Markdown files and ${result.repositoryTextFiles.length} repository text files.\n`,
  );
}
