import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkNoticeFile,
  checkRuntimeContributorArtifacts,
  generateThirdPartyNotice,
} from "./generate-third-party-notices.mjs";

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "slots-third-party-notices-"));
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writePackage(packagePath, packageJson, licenseText) {
  const packageRoot = path.join(fixtureRoot, packagePath);
  mkdirSync(packageRoot, { recursive: true });
  writeJson(path.join(packageRoot, "package.json"), packageJson);
  if (licenseText !== null) {
    writeFileSync(path.join(packageRoot, "LICENSE"), licenseText, "utf8");
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

try {
  const mitText = "MIT License\n\nCopyright (c) Fixture\n";
  const contributorThirdPartyText = "MIT License\n\nCopyright (c) Fixture Upstream\n";
  const lock = {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture",
        version: "1.0.0",
        dependencies: { "runtime-package": "1.0.0" },
        devDependencies: { "build-contributor": "1.0.0", "development-package": "1.0.0" },
      },
      "node_modules/@types/runtime-package": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/@types/runtime-package/-/runtime-package-1.0.0.tgz",
        integrity: "sha512-dHlwZXM=",
        license: "MIT",
      },
      "node_modules/development-package": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/development-package/-/development-package-1.0.0.tgz",
        integrity: "sha512-ZGV2ZWxvcG1lbnQ=",
        dev: true,
      },
      "node_modules/build-contributor": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/build-contributor/-/build-contributor-1.0.0.tgz",
        integrity: "sha512-Y29udHJpYnV0b3I=",
        dev: true,
        license: "MIT",
      },
      "node_modules/runtime-package": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/runtime-package/-/runtime-package-1.0.0.tgz",
        integrity: "sha512-cnVudGltZQ==",
        license: "MIT",
      },
    },
  };
  writeJson(path.join(fixtureRoot, "package-lock.json"), lock);
  const artifactFingerprints = {
    "fixture-build-helper": {
      contributor: "build-contributor@1.0.0",
      maxSpanBytes: 256,
      orderedFragments: ["fixtureHelperStart", "fixtureHelperEnd"],
    },
  };
  const runtimeContributors = {
    "build-contributor@1.0.0": {
      additionalLicenseDocuments: [{
        licenseFile: "third-party-licenses/BUILD-THIRD-PARTY-LICENSE",
        licenseSha256: sha256(contributorThirdPartyText),
        sourceRevision: "2222222222222222222222222222222222222222",
        sourceUrl: "https://example.invalid/source/2222222222222222222222222222222222222222/THIRD-PARTY-LICENSE",
      }],
      declaredLicense: "MIT",
      fingerprints: ["fixture-build-helper"],
      integrity: "sha512-Y29udHJpYnV0b3I=",
      licenseSha256: sha256(mitText),
      reason: "构建器向浏览器生产分块写入运行辅助代码。",
    },
  };
  writeJson(path.join(fixtureRoot, "third-party-licenses", "overrides.json"), {
    schemaVersion: 2,
    artifactFingerprints,
    packages: {},
    runtimeContributors,
  });
  writeFileSync(
    path.join(fixtureRoot, "third-party-licenses", "BUILD-THIRD-PARTY-LICENSE"),
    contributorThirdPartyText,
    "utf8",
  );
  writePackage("node_modules/runtime-package", { name: "runtime-package", version: "1.0.0", license: "MIT" }, mitText);
  writePackage("node_modules/development-package", { name: "development-package", version: "1.0.0" }, null);
  writePackage("node_modules/build-contributor", { name: "build-contributor", version: "1.0.0", license: "MIT" }, mitText);
  writePackage("node_modules/@types/runtime-package", {
    name: "@types/runtime-package",
    version: "1.0.0",
    license: "MIT",
    types: "index.d.ts",
  }, null);
  mkdirSync(path.join(fixtureRoot, "dist", "assets"), { recursive: true });
  const fixtureBundlePath = path.join(fixtureRoot, "dist", "assets", "runtime.js");
  writeFileSync(fixtureBundlePath, "const fixtureHelperStart=1;const fixtureHelperEnd=2;\n", "utf8");

  const notice = generateThirdPartyNotice({ webRoot: fixtureRoot });
  assert.match(notice, /runtime-package@1\.0\.0/u);
  assert.match(notice, /build-contributor@1\.0\.0 \[构建器运行码贡献者：构建器向浏览器生产分块写入运行辅助代码。\]/u);
  assert.doesNotMatch(notice, /development-package/u);
  assert.doesNotMatch(notice, /@types\/runtime-package/u);
  assert.match(notice, /包完整性：sha512-Y29udHJpYnV0b3I=/u);
  assert.match(notice, new RegExp(`许可 SHA-256：${sha256(mitText)}`, "u"));
  assert.match(notice, /Copyright \(c\) Fixture Upstream/u);
  assert.equal(checkRuntimeContributorArtifacts({ webRoot: fixtureRoot }).length, 1);

  writeJson(path.join(fixtureRoot, "third-party-licenses", "overrides.json"), {
    schemaVersion: 2,
    artifactFingerprints,
    packages: {},
    runtimeContributors: {},
  });
  assert.throws(
    () => checkRuntimeContributorArtifacts({ webRoot: fixtureRoot }),
    /产物指纹 fixture-build-helper 已命中.*贡献者 build-contributor@1\.0\.0 未登记/u,
  );
  writeJson(path.join(fixtureRoot, "third-party-licenses", "overrides.json"), {
    schemaVersion: 2,
    artifactFingerprints,
    packages: {},
    runtimeContributors,
  });
  writeFileSync(fixtureBundlePath, "const helperWasRemoved=true;\n", "utf8");
  assert.throws(
    () => checkRuntimeContributorArtifacts({ webRoot: fixtureRoot }),
    /产物指纹 fixture-build-helper 未命中，覆盖项可能已经过期/u,
  );
  writeFileSync(fixtureBundlePath, "const fixtureHelperStart=1;const fixtureHelperEnd=2;\n", "utf8");

  runtimeContributors["build-contributor@1.0.0"].integrity = "sha512-ZXhwaXJlZA==";
  writeJson(path.join(fixtureRoot, "third-party-licenses", "overrides.json"), {
    schemaVersion: 2,
    artifactFingerprints,
    packages: {},
    runtimeContributors,
  });
  assert.throws(() => generateThirdPartyNotice({ webRoot: fixtureRoot }), /integrity 与审核绑定不一致/u);
  runtimeContributors["build-contributor@1.0.0"].integrity = "sha512-Y29udHJpYnV0b3I=";
  runtimeContributors["build-contributor@1.0.0"].licenseSha256 = "0".repeat(64);
  writeJson(path.join(fixtureRoot, "third-party-licenses", "overrides.json"), {
    schemaVersion: 2,
    artifactFingerprints,
    packages: {},
    runtimeContributors,
  });
  assert.throws(() => generateThirdPartyNotice({ webRoot: fixtureRoot }), /许可原文与审核摘要不一致/u);
  runtimeContributors["build-contributor@1.0.0"].licenseSha256 = sha256(mitText);
  writeJson(path.join(fixtureRoot, "third-party-licenses", "overrides.json"), {
    schemaVersion: 2,
    artifactFingerprints,
    packages: {},
    runtimeContributors,
  });
  writeFileSync(
    path.join(fixtureRoot, "third-party-licenses", "BUILD-THIRD-PARTY-LICENSE"),
    `${contributorThirdPartyText.trimEnd()} tampered\n`,
    "utf8",
  );
  assert.throws(
    () => generateThirdPartyNotice({ webRoot: fixtureRoot }),
    /附加许可原文 1.*摘要不匹配/u,
  );
  writeFileSync(
    path.join(fixtureRoot, "third-party-licenses", "BUILD-THIRD-PARTY-LICENSE"),
    contributorThirdPartyText,
    "utf8",
  );

  mkdirSync(path.join(fixtureRoot, "public"), { recursive: true });
  writeFileSync(path.join(fixtureRoot, "public", "THIRD_PARTY_NOTICES.txt"), "过期声明\n", "utf8");
  assert.throws(() => checkNoticeFile({ webRoot: fixtureRoot, notice }), /已过期/u);
  writeFileSync(path.join(fixtureRoot, "public", "THIRD_PARTY_NOTICES.txt"), notice, "utf8");
  assert.doesNotThrow(() => checkNoticeFile({ webRoot: fixtureRoot, notice }));

  unlinkSync(path.join(fixtureRoot, "node_modules", "runtime-package", "LICENSE"));
  assert.throws(() => generateThirdPartyNotice({ webRoot: fixtureRoot }), /没有随包发布许可原文/u);
  writeFileSync(path.join(fixtureRoot, "node_modules", "runtime-package", "LICENSE"), mitText, "utf8");

  lock.packages[""].dependencies["runtime-with-override"] = "2.0.0";
  lock.packages["node_modules/runtime-with-override"] = {
    version: "2.0.0",
    resolved: "https://registry.npmjs.org/runtime-with-override/-/runtime-with-override-2.0.0.tgz",
    integrity: "sha512-b3ZlcnJpZGU=",
    license: "SEE FIXTURE-LICENSE",
  };
  writeJson(path.join(fixtureRoot, "package-lock.json"), lock);
  writePackage("node_modules/runtime-with-override", {
    name: "runtime-with-override",
    version: "2.0.0",
    license: "SEE FIXTURE-LICENSE",
  }, null);
  const overrideText = "Fixture Runtime License\n";
  writeFileSync(path.join(fixtureRoot, "third-party-licenses", "FIXTURE-LICENSE"), overrideText, "utf8");
  const overrideManifest = {
    schemaVersion: 2,
    artifactFingerprints,
    packages: {
      "runtime-with-override@2.0.0": {
        declaredLicense: "SEE FIXTURE-LICENSE",
        licenseFile: "third-party-licenses/FIXTURE-LICENSE",
        licenseSha256: sha256(overrideText),
        sourceRevision: "1111111111111111111111111111111111111111",
        sourceUrl: "https://example.invalid/source/1111111111111111111111111111111111111111/FIXTURE-LICENSE",
      },
    },
    runtimeContributors,
  };
  writeJson(path.join(fixtureRoot, "third-party-licenses", "overrides.json"), overrideManifest);
  assert.match(generateThirdPartyNotice({ webRoot: fixtureRoot }), /runtime-with-override@2\.0\.0/u);

  overrideManifest.packages["runtime-with-override@2.0.0"].licenseSha256 = "0".repeat(64);
  writeJson(path.join(fixtureRoot, "third-party-licenses", "overrides.json"), overrideManifest);
  assert.throws(() => generateThirdPartyNotice({ webRoot: fixtureRoot }), /摘要不匹配/u);

  assert.equal(readFileSync(path.join(fixtureRoot, "node_modules", "runtime-package", "LICENSE"), "utf8"), mitText);
  assert.match(
    readFileSync(path.join(webRoot, "public", "THIRD_PARTY_NOTICES.txt"), "utf8"),
    /rolldown@1\.1\.5 \[构建器运行码贡献者/u,
  );
  assert.match(
    readFileSync(path.join(webRoot, "public", "THIRD_PARTY_NOTICES.txt"), "utf8"),
    /Copyright \(c\) 2017 \[these people\]\(https:\/\/github\.com\/rollup\/rollup\/graphs\/contributors\)/u,
  );
  assert.match(
    readFileSync(path.join(webRoot, "public", "THIRD_PARTY_NOTICES.txt"), "utf8"),
    /Copyright \(c\) 2020 Evan Wallace/u,
  );
  process.stdout.write("第三方许可声明失败闭合测试通过。\n");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
