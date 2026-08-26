import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const defaultWebRoot = path.resolve(path.dirname(currentFile), "..");
const legalFilePattern = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/iu;

function fail(message) {
  throw new Error(`第三方许可声明生成失败：${message}`);
}

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function normalizeLegalText(value) {
  const normalized = value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").replace(/[\t ]+$/gmu, "");
  const withoutTrailingWhitespace = normalized.replace(/\s+$/u, "");
  return `${withoutTrailingWhitespace}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readJson(filePath, description) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${description}无法读取或不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

function requirePlainObject(value, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${description}必须是对象`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, description) {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.join("\n") !== expected.join("\n")) {
    fail(`${description}的字段集合不符合固定契约`);
  }
}

function resolveContainedFile(webRoot, relativePath, description) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    fail(`${description}必须是非空相对路径`);
  }
  const resolvedRoot = path.resolve(webRoot);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`${description}不得离开 Web 源码目录`);
  }
  if (!existsSync(resolvedPath) || !lstatSync(resolvedPath).isFile()) {
    fail(`${description}不存在或不是普通文件：${relativePath}`);
  }
  return resolvedPath;
}

function validatePinnedLicenseDocument(webRoot, entryValue, description) {
  const entry = requirePlainObject(entryValue, description);
  requireExactKeys(
    entry,
    ["licenseFile", "licenseSha256", "sourceRevision", "sourceUrl"],
    description,
  );
  if (!/^[0-9a-f]{64}$/u.test(entry.licenseSha256)) {
    fail(`${description}的 licenseSha256 无效`);
  }
  if (!/^[0-9a-f]{40}$/u.test(entry.sourceRevision)) {
    fail(`${description}的 sourceRevision 必须是完整提交摘要`);
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(entry.sourceUrl);
  } catch {
    fail(`${description}的 sourceUrl 无效`);
  }
  if (
    sourceUrl.protocol !== "https:" ||
    sourceUrl.username !== "" ||
    sourceUrl.password !== "" ||
    sourceUrl.hash !== "" ||
    !sourceUrl.pathname.includes(`/${entry.sourceRevision}/`)
  ) {
    fail(`${description}必须使用绑定完整提交摘要的 HTTPS 来源`);
  }
  const licensePath = resolveContainedFile(webRoot, entry.licenseFile, `${description}的 licenseFile`);
  const licenseText = normalizeLegalText(readFileSync(licensePath, "utf8"));
  if (licenseText.trim().length === 0 || licenseText.includes("\u0000")) {
    fail(`${description}的许可原文为空或包含 NUL 字节`);
  }
  if (sha256(licenseText) !== entry.licenseSha256) {
    fail(`${description}的许可原文摘要不匹配`);
  }
  return { ...entry, licenseText };
}

function validateOverrides(webRoot, overrides) {
  const object = requirePlainObject(overrides, "许可覆盖清单");
  if (object.schemaVersion !== 2) {
    fail("许可覆盖清单 schemaVersion 必须为 2");
  }
  requireExactKeys(
    object,
    ["artifactFingerprints", "packages", "runtimeContributors", "schemaVersion"],
    "许可覆盖清单顶层",
  );
  const packages = requirePlainObject(object.packages, "许可覆盖清单 packages");
  const fingerprintEntries = requirePlainObject(
    object.artifactFingerprints,
    "许可覆盖清单 artifactFingerprints",
  );
  const contributorEntries = requirePlainObject(
    object.runtimeContributors,
    "许可覆盖清单 runtimeContributors",
  );
  const validated = new Map();
  const runtimeContributors = new Map();
  const artifactFingerprints = new Map();
  const expectedKeys = [
    "declaredLicense",
    "licenseFile",
    "licenseSha256",
    "sourceRevision",
    "sourceUrl",
  ];

  for (const packageId of Object.keys(packages).sort(compareText)) {
    const entry = requirePlainObject(packages[packageId], `许可覆盖项 ${packageId}`);
    requireExactKeys(entry, expectedKeys, `许可覆盖项 ${packageId}`);
    if (typeof entry.declaredLicense !== "string" || entry.declaredLicense.length === 0) {
      fail(`许可覆盖项 ${packageId} 缺少 declaredLicense`);
    }
    const pinnedDocument = validatePinnedLicenseDocument(webRoot, {
      licenseFile: entry.licenseFile,
      licenseSha256: entry.licenseSha256,
      sourceRevision: entry.sourceRevision,
      sourceUrl: entry.sourceUrl,
    }, `许可覆盖项 ${packageId}`);
    validated.set(packageId, { ...entry, licenseText: pinnedDocument.licenseText });
  }
  for (const fingerprintId of Object.keys(fingerprintEntries).sort(compareText)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fingerprintId)) {
      fail(`产物指纹标识无效：${fingerprintId}`);
    }
    const entry = requirePlainObject(fingerprintEntries[fingerprintId], `产物指纹 ${fingerprintId}`);
    requireExactKeys(entry, ["contributor", "maxSpanBytes", "orderedFragments"], `产物指纹 ${fingerprintId}`);
    if (typeof entry.contributor !== "string" || !/^(@[^/]+\/)?[^@/]+@[^@/]+$/u.test(entry.contributor)) {
      fail(`产物指纹 ${fingerprintId} 缺少精确贡献者身份`);
    }
    if (!Number.isSafeInteger(entry.maxSpanBytes) || entry.maxSpanBytes < 128 || entry.maxSpanBytes > 1024 * 1024) {
      fail(`产物指纹 ${fingerprintId} 的 maxSpanBytes 必须在 128 字节至 1 MiB 之间`);
    }
    if (!Array.isArray(entry.orderedFragments) || entry.orderedFragments.length < 2 || entry.orderedFragments.length > 16) {
      fail(`产物指纹 ${fingerprintId} 必须包含 2 至 16 个有序片段`);
    }
    const fragments = [];
    for (const fragment of entry.orderedFragments) {
      if (
        typeof fragment !== "string" ||
        fragment.length === 0 ||
        Buffer.byteLength(fragment, "utf8") > 256 ||
        /[\u0000-\u001f\u007f]/u.test(fragment)
      ) {
        fail(`产物指纹 ${fingerprintId} 包含无效片段`);
      }
      fragments.push(fragment);
    }
    if (new Set(fragments).size !== fragments.length) {
      fail(`产物指纹 ${fingerprintId} 不允许重复片段`);
    }
    artifactFingerprints.set(fingerprintId, { ...entry, orderedFragments: fragments });
  }
  for (const packageId of Object.keys(contributorEntries).sort(compareText)) {
    const entry = requirePlainObject(contributorEntries[packageId], `运行码贡献者 ${packageId}`);
    requireExactKeys(
      entry,
      [
        "additionalLicenseDocuments",
        "declaredLicense",
        "fingerprints",
        "integrity",
        "licenseSha256",
        "reason",
      ],
      `运行码贡献者 ${packageId}`,
    );
    if (typeof entry.declaredLicense !== "string" || entry.declaredLicense.length === 0) {
      fail(`运行码贡献者 ${packageId} 缺少 declaredLicense`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)) {
      fail(`运行码贡献者 ${packageId} 的 integrity 必须是精确 sha512 摘要`);
    }
    if (!/^[0-9a-f]{64}$/u.test(entry.licenseSha256)) {
      fail(`运行码贡献者 ${packageId} 的 licenseSha256 无效`);
    }
    if (typeof entry.reason !== "string" || entry.reason.length < 10 || !/[\u3400-\u9fff]/u.test(entry.reason)) {
      fail(`运行码贡献者 ${packageId} 必须记录可审计的中文原因`);
    }
    if (!Array.isArray(entry.fingerprints) || entry.fingerprints.length === 0 || new Set(entry.fingerprints).size !== entry.fingerprints.length) {
      fail(`运行码贡献者 ${packageId} 必须绑定至少一个不重复的产物指纹`);
    }
    for (const fingerprintId of entry.fingerprints) {
      if (typeof fingerprintId !== "string" || artifactFingerprints.get(fingerprintId)?.contributor !== packageId) {
        fail(`运行码贡献者 ${packageId} 的产物指纹绑定无效：${String(fingerprintId)}`);
      }
    }
    if (!Array.isArray(entry.additionalLicenseDocuments)
      || entry.additionalLicenseDocuments.length > 16) {
      fail(`运行码贡献者 ${packageId} 的 additionalLicenseDocuments 必须是不超过 16 项的数组`);
    }
    const additionalLicenseDocuments = entry.additionalLicenseDocuments.map((document, index) => (
      validatePinnedLicenseDocument(
        webRoot,
        document,
        `运行码贡献者 ${packageId} 的附加许可原文 ${index + 1}`,
      )
    ));
    if (new Set(additionalLicenseDocuments.map((document) => document.licenseSha256)).size
      !== additionalLicenseDocuments.length) {
      fail(`运行码贡献者 ${packageId} 不允许重复附加许可原文`);
    }
    runtimeContributors.set(packageId, {
      ...entry,
      additionalLicenseDocuments,
      fingerprints: [...entry.fingerprints],
    });
  }
  for (const [fingerprintId, fingerprint] of artifactFingerprints) {
    const contributor = runtimeContributors.get(fingerprint.contributor);
    if (contributor !== undefined && !contributor.fingerprints.includes(fingerprintId)) {
      fail(`产物指纹 ${fingerprintId} 没有被运行码贡献者 ${fingerprint.contributor} 反向绑定`);
    }
  }
  return { licenseOverrides: validated, runtimeContributors, artifactFingerprints };
}

function packageNameFromLockPath(packagePath) {
  const marker = "node_modules/";
  const start = packagePath.lastIndexOf(marker);
  const suffix = packagePath.slice(start + marker.length);
  const parts = suffix.split("/");
  if (parts[0]?.startsWith("@")) {
    if (parts.length < 2) {
      fail(`锁文件包路径无效：${packagePath}`);
    }
    return `${parts[0]}/${parts[1]}`;
  }
  if (!parts[0]) {
    fail(`锁文件包路径无效：${packagePath}`);
  }
  return parts[0];
}

function isDeclarationOnlyPackage(packageJson) {
  if (typeof packageJson.name !== "string" || !packageJson.name.startsWith("@types/")) {
    return false;
  }
  for (const runtimeField of ["main", "module", "browser", "exports", "bin"]) {
    const value = packageJson[runtimeField];
    if (value !== undefined && value !== null && value !== "") {
      fail(`类型声明包 ${packageJson.name} 出现运行时代码入口，不能自动排除`);
    }
  }
  return true;
}

function readPackagedLegalFiles(packageDirectory, packageId) {
  const candidates = readdirSync(packageDirectory)
    .filter((name) => legalFilePattern.test(name))
    .sort(compareText);
  const documents = [];
  for (const name of candidates) {
    const filePath = path.join(packageDirectory, name);
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`${packageId} 的许可文件 ${name} 必须是普通文件且不能是符号链接`);
    }
    if (metadata.size > 1024 * 1024) {
      fail(`${packageId} 的许可文件 ${name} 超过 1 MiB 安全上限`);
    }
    const text = normalizeLegalText(readFileSync(filePath, "utf8"));
    if (text.trim().length === 0 || text.includes("\u0000")) {
      fail(`${packageId} 的许可文件 ${name} 为空或包含 NUL 字节`);
    }
    documents.push({ name, text, sourceUrl: null });
  }
  return documents;
}

function collectRuntimePackages(webRoot, lock, licenseOverrides, runtimeContributors) {
  const lockObject = requirePlainObject(lock, "package-lock.json");
  if (lockObject.lockfileVersion !== 3) {
    fail("package-lock.json 必须使用 lockfileVersion 3");
  }
  const lockPackages = requirePlainObject(lockObject.packages, "package-lock.json packages");
  const rootPackage = requirePlainObject(lockPackages[""], "package-lock.json 根包");
  const rootDependencies = Object.keys(requirePlainObject(rootPackage.dependencies, "根包 dependencies"));
  const collected = [];
  const collectedIds = new Set();
  const usedOverrides = new Set();
  const usedRuntimeContributors = new Set();

  for (const packagePath of Object.keys(lockPackages).sort(compareText)) {
    if (packagePath === "" || !packagePath.includes("node_modules/")) {
      continue;
    }
    const lockEntry = requirePlainObject(lockPackages[packagePath], `锁文件条目 ${packagePath}`);
    const lockedPackageId = typeof lockEntry.version === "string"
      ? `${packageNameFromLockPath(packagePath)}@${lockEntry.version}`
      : null;
    const contributor = lockedPackageId === null ? undefined : runtimeContributors.get(lockedPackageId);
    if (lockEntry.dev === true && contributor === undefined) {
      continue;
    }
    if (lockEntry.link === true) {
      fail(`生产依赖 ${packagePath} 不能使用未锁定的本地链接`);
    }
    if (typeof lockEntry.version !== "string" || typeof lockEntry.resolved !== "string" || typeof lockEntry.integrity !== "string") {
      fail(`生产依赖 ${packagePath} 缺少 version、resolved 或 integrity`);
    }
    if (lockedPackageId === null) {
      fail(`生产依赖 ${packagePath} 缺少有效版本`);
    }
    if (lockEntry.dev !== true && contributor !== undefined) {
      fail(`运行码贡献者 ${lockedPackageId} 已成为生产依赖，应移除特殊允许项`);
    }
    if (
      !lockEntry.resolved.startsWith("https://registry.npmjs.org/") ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockEntry.integrity)
    ) {
      fail(`生产依赖 ${packagePath} 必须绑定 npm HTTPS 包地址和 sha512 完整性`);
    }

    const packageDirectory = path.resolve(webRoot, packagePath);
    const packageJsonPath = path.join(packageDirectory, "package.json");
    if (!existsSync(packageJsonPath) || !lstatSync(packageJsonPath).isFile()) {
      fail(`生产依赖 ${packagePath} 未按锁文件安装`);
    }
    const packageJson = requirePlainObject(readJson(packageJsonPath, `${packagePath}/package.json`), `${packagePath}/package.json`);
    if (`${packageJson.name}@${packageJson.version}` !== lockedPackageId) {
      fail(`已安装生产依赖 ${packagePath} 与锁文件身份不一致`);
    }
    if (isDeclarationOnlyPackage(packageJson)) {
      continue;
    }

    const packageId = `${packageJson.name}@${packageJson.version}`;
    if (collectedIds.has(packageId)) {
      fail(`生产依赖身份重复：${packageId}`);
    }
    collectedIds.add(packageId);
    const override = licenseOverrides.get(packageId);
    const declaredLicenses = [lockEntry.license, packageJson.license]
      .filter((value) => typeof value === "string" && value.length > 0);
    if (new Set(declaredLicenses).size > 1) {
      fail(`${packageId} 的锁文件与已安装包许可证声明不一致`);
    }
    let declaredLicense = declaredLicenses[0];
    let documents;
    if (override !== undefined) {
      usedOverrides.add(packageId);
      if (declaredLicense !== undefined && declaredLicense !== override.declaredLicense) {
        fail(`${packageId} 的许可覆盖与包内许可证声明不一致`);
      }
      declaredLicense = override.declaredLicense;
      const packagedDocuments = readPackagedLegalFiles(packageDirectory, packageId);
      if (packagedDocuments.length > 0) {
        fail(`${packageId} 已随包提供许可原文，不应继续使用覆盖项`);
      }
      documents = [{
        name: override.licenseFile,
        text: override.licenseText,
        sourceUrl: override.sourceUrl,
      }];
    } else {
      if (typeof declaredLicense !== "string" || declaredLicense.length === 0 || /^SEE\b/iu.test(declaredLicense)) {
        fail(`${packageId} 缺少可直接核验的许可证声明或覆盖项`);
      }
      documents = readPackagedLegalFiles(packageDirectory, packageId);
      if (documents.length === 0) {
        fail(`${packageId} 没有随包发布许可原文，也没有经摘要固定的覆盖项`);
      }
    }
    if (contributor !== undefined) {
      if (lockEntry.integrity !== contributor.integrity) {
        fail(`运行码贡献者 ${packageId} 的锁文件 integrity 与审核绑定不一致`);
      }
      if (declaredLicense !== contributor.declaredLicense) {
        fail(`运行码贡献者 ${packageId} 的许可证声明与审核绑定不一致`);
      }
      if (!documents.some((document) => sha256(document.text) === contributor.licenseSha256)) {
        fail(`运行码贡献者 ${packageId} 的许可原文与审核摘要不一致`);
      }
      documents.push(...contributor.additionalLicenseDocuments.map((document) => ({
        name: document.licenseFile,
        text: document.licenseText,
        sourceUrl: document.sourceUrl,
      })));
    }
    collected.push({
      id: packageId,
      declaredLicense,
      documents,
      role: contributor === undefined ? "production" : "build-contributor",
      contributor: contributor ?? null,
    });
    if (contributor !== undefined) {
      usedRuntimeContributors.add(packageId);
    }
  }

  for (const packageId of licenseOverrides.keys()) {
    if (!usedOverrides.has(packageId)) {
      fail(`许可覆盖项没有对应当前生产依赖：${packageId}`);
    }
  }
  for (const packageId of runtimeContributors.keys()) {
    if (!usedRuntimeContributors.has(packageId)) {
      fail(`运行码贡献者允许项没有对应当前开发依赖：${packageId}`);
    }
  }
  for (const dependencyName of rootDependencies) {
    if (![...collectedIds].some((packageId) => packageId.startsWith(`${dependencyName}@`))) {
      fail(`根生产依赖未进入许可清单：${dependencyName}`);
    }
  }
  if (collected.length === 0) {
    fail("生产依赖许可清单不能为空");
  }
  return collected.sort((left, right) => compareText(left.id, right.id));
}

function renderNotice(packages) {
  const groupsByHash = new Map();
  for (const packageEntry of packages) {
    for (const document of packageEntry.documents) {
      const contentHash = sha256(document.text);
      let group = groupsByHash.get(contentHash);
      if (group === undefined) {
        group = {
          hash: contentHash,
          text: document.text,
          packages: new Set(),
          packagedFiles: new Set(),
          sourceUrls: new Set(),
        };
        groupsByHash.set(contentHash, group);
      } else if (group.text !== document.text) {
        fail(`许可原文 SHA-256 冲突：${contentHash}`);
      }
      group.packages.add(packageEntry.id);
      if (document.sourceUrl === null) {
        group.packagedFiles.add(document.name);
      } else {
        group.sourceUrls.add(document.sourceUrl);
      }
    }
  }

  const groups = [...groupsByHash.values()].sort((left, right) => compareText(left.hash, right.hash));
  const groupIdByHash = new Map(groups.map((group, index) => [group.hash, `L${String(index + 1).padStart(3, "0")}`]));
  const productionPackageCount = packages.filter((entry) => entry.role === "production").length;
  const buildContributorCount = packages.length - productionPackageCount;
  const lines = [
    "PRIMAL RAMPAGE WEB 第三方许可声明",
    "",
    "本文件由锁定依赖和随包许可原文确定性生成，禁止手工修改。",
    "范围包含 package-lock.json 中非 dev 的浏览器运行依赖，以及确有代码写入生产分块的显式构建器贡献者。",
    "纯 @types 声明包和未向浏览器制品写入代码的开发、测试依赖不会进入本声明或运行镜像。",
    "依赖版本、下载地址和完整性摘要以 Web 源码目录的 package-lock.json 为准。",
    `当前包含 ${productionPackageCount} 个生产依赖软件包、${buildContributorCount} 个构建器运行码贡献者、${groups.length} 份不重复许可原文。`,
    "",
    "一、生产软件包清单",
    "",
  ];

  for (const packageEntry of packages) {
    const references = packageEntry.documents
      .map((document) => groupIdByHash.get(sha256(document.text)))
      .sort(compareText);
    const role = packageEntry.role === "build-contributor"
      ? ` [构建器运行码贡献者：${packageEntry.contributor.reason}]`
      : "";
    const auditBinding = packageEntry.role === "build-contributor"
      ? ` | 包完整性：${packageEntry.contributor.integrity} | 许可 SHA-256：${packageEntry.contributor.licenseSha256}`
      : "";
    lines.push(`- ${packageEntry.id}${role} | 声明：${packageEntry.declaredLicense}${auditBinding} | 原文：${references.join(", ")}`);
  }

  lines.push("", "二、许可原文", "");
  for (const group of groups) {
    const groupId = groupIdByHash.get(group.hash);
    lines.push(`===== ${groupId} | SHA-256 ${group.hash} =====`, "", "适用软件包：");
    for (const packageId of [...group.packages].sort(compareText)) {
      lines.push(`- ${packageId}`);
    }
    if (group.packagedFiles.size > 0) {
      lines.push("", `来源：适用 npm 包内的 ${[...group.packagedFiles].sort(compareText).join(", ")}；包字节由锁文件 integrity 固定。`);
    }
    if (group.sourceUrls.size > 0) {
      lines.push("", "经摘要固定的上游许可来源：");
      for (const sourceUrl of [...group.sourceUrls].sort(compareText)) {
        lines.push(`- ${sourceUrl}`);
      }
    }
    lines.push("", group.text.trimEnd(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function generateThirdPartyNotice({ webRoot = defaultWebRoot } = {}) {
  const resolvedWebRoot = path.resolve(webRoot);
  const lock = readJson(path.join(resolvedWebRoot, "package-lock.json"), "package-lock.json");
  const overrideDocument = readJson(
    path.join(resolvedWebRoot, "third-party-licenses", "overrides.json"),
    "许可覆盖清单",
  );
  const { licenseOverrides, runtimeContributors } = validateOverrides(resolvedWebRoot, overrideDocument);
  return renderNotice(collectRuntimePackages(resolvedWebRoot, lock, licenseOverrides, runtimeContributors));
}

export function checkNoticeFile({ webRoot = defaultWebRoot, notice = generateThirdPartyNotice({ webRoot }) } = {}) {
  const noticePath = path.join(path.resolve(webRoot), "public", "THIRD_PARTY_NOTICES.txt");
  if (!existsSync(noticePath) || !lstatSync(noticePath).isFile()) {
    fail("缺少 public/THIRD_PARTY_NOTICES.txt");
  }
  const committed = normalizeLegalText(readFileSync(noticePath, "utf8"));
  if (committed !== notice) {
    fail("public/THIRD_PARTY_NOTICES.txt 已过期；请运行 npm run licenses:generate 并提交结果");
  }
}

function matchesOrderedFingerprint(contents, orderedFragments, maxSpanBytes) {
  const fragments = orderedFragments.map((fragment) => Buffer.from(fragment, "utf8"));
  let firstOffset = contents.indexOf(fragments[0]);
  while (firstOffset !== -1) {
    let nextOffset = firstOffset + fragments[0].length;
    let matched = true;
    for (const fragment of fragments.slice(1)) {
      const offset = contents.indexOf(fragment, nextOffset);
      if (offset === -1) {
        matched = false;
        break;
      }
      nextOffset = offset + fragment.length;
    }
    if (matched && nextOffset - firstOffset <= maxSpanBytes) {
      return true;
    }
    firstOffset = contents.indexOf(fragments[0], firstOffset + 1);
  }
  return false;
}

export function checkRuntimeContributorArtifacts({ webRoot = defaultWebRoot } = {}) {
  const resolvedWebRoot = path.resolve(webRoot);
  const overrideDocument = readJson(
    path.join(resolvedWebRoot, "third-party-licenses", "overrides.json"),
    "许可覆盖清单",
  );
  const { runtimeContributors, artifactFingerprints } = validateOverrides(resolvedWebRoot, overrideDocument);
  const assetsDirectory = path.join(resolvedWebRoot, "dist", "assets");
  if (!existsSync(assetsDirectory)) {
    fail("缺少待核验的 dist/assets 浏览器产物目录");
  }
  const assetsMetadata = lstatSync(assetsDirectory);
  if (!assetsMetadata.isDirectory() || assetsMetadata.isSymbolicLink()) {
    fail("dist/assets 必须是普通目录且不能是符号链接");
  }
  const javascriptFiles = [];
  let totalBytes = 0;
  for (const name of readdirSync(assetsDirectory).filter((entry) => entry.endsWith(".js")).sort(compareText)) {
    const filePath = path.join(assetsDirectory, name);
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`浏览器产物 ${name} 必须是普通文件且不能是符号链接`);
    }
    if (metadata.size > 16 * 1024 * 1024) {
      fail(`浏览器产物 ${name} 超过 16 MiB 安全上限`);
    }
    totalBytes += metadata.size;
    if (totalBytes > 128 * 1024 * 1024) {
      fail("浏览器 JavaScript 产物总量超过 128 MiB 安全上限");
    }
    javascriptFiles.push({ name, contents: readFileSync(filePath) });
  }
  if (javascriptFiles.length === 0) {
    fail("dist/assets 中没有可核验的 JavaScript 产物");
  }

  const matches = [];
  for (const [fingerprintId, fingerprint] of artifactFingerprints) {
    const matchedFiles = javascriptFiles
      .filter(({ contents }) => matchesOrderedFingerprint(contents, fingerprint.orderedFragments, fingerprint.maxSpanBytes))
      .map(({ name }) => name);
    const contributor = runtimeContributors.get(fingerprint.contributor);
    if (matchedFiles.length > 0 && contributor === undefined) {
      fail(`产物指纹 ${fingerprintId} 已命中 ${matchedFiles.join(", ")}，但贡献者 ${fingerprint.contributor} 未登记`);
    }
    if (matchedFiles.length === 0 && contributor !== undefined) {
      fail(`运行码贡献者 ${fingerprint.contributor} 的产物指纹 ${fingerprintId} 未命中，覆盖项可能已经过期`);
    }
    if (matchedFiles.length > 0) {
      matches.push({ contributor: fingerprint.contributor, files: matchedFiles, fingerprintId });
    }
  }
  return matches;
}

function runCommand() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--check", "--check-artifacts", "--write"].includes(mode)) {
    fail("用法：node scripts/generate-third-party-notices.mjs --check|--check-artifacts|--write");
  }
  const notice = generateThirdPartyNotice();
  if (mode === "--check") {
    checkNoticeFile({ notice });
    process.stdout.write("第三方生产依赖许可声明校验通过。\n");
    return;
  }
  if (mode === "--check-artifacts") {
    checkNoticeFile({ notice });
    const matches = checkRuntimeContributorArtifacts();
    process.stdout.write(`第三方构建器运行码产物指纹校验通过，共命中 ${matches.length} 项。\n`);
    return;
  }
  const outputDirectory = path.join(defaultWebRoot, "public");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(path.join(outputDirectory, "THIRD_PARTY_NOTICES.txt"), notice, { encoding: "utf8", mode: 0o644 });
  process.stdout.write("第三方生产依赖许可声明已确定性生成。\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === currentFile) {
  try {
    runCommand();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
