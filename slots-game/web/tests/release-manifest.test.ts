// @ts-nocheck -- 清单实现是供 Node 构建与运维脚本复用的纯 JavaScript 模块。
import { describe, expect, it } from "vitest";

import {
  createReleaseManifest,
  normalizePublicReleaseIdentity,
  verifyReleaseManifest,
} from "../scripts/release-manifest.mjs";

const file = (path: string, character: string) => ({
  path,
  bytes: 100,
  sha256: character.repeat(64),
});

const identity = {
  version: "2026.08.16-rc.1",
  revision: "0123456789abcdef0123456789abcdef01234567",
};

describe("确定性发布清单", () => {
  it("相同内容不受输入顺序影响并产生同一 releaseId", () => {
    const first = createReleaseManifest({
      ...identity,
      files: [file("assets/z.js", "a"), file("assets/a.css", "b")],
      requireRevision: true,
    });
    const second = createReleaseManifest({
      ...identity,
      files: [file("assets/a.css", "b"), file("assets/z.js", "a")],
      requireRevision: true,
    });

    expect(first).toEqual(second);
    expect(first.files.map(({ path }) => path)).toEqual(["assets/a.css", "assets/z.js"]);
    expect(first.releaseId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("文件摘要、版本或提交变化都会改变 releaseId", () => {
    const base = createReleaseManifest({ ...identity, files: [file("index.html", "a")], requireRevision: true });
    const changedFile = createReleaseManifest({ ...identity, files: [file("index.html", "b")], requireRevision: true });
    const changedVersion = createReleaseManifest({ ...identity, version: "2026.08.17", files: [file("index.html", "a")], requireRevision: true });
    const changedRevision = createReleaseManifest({ ...identity, revision: "f".repeat(40), files: [file("index.html", "a")], requireRevision: true });

    expect(new Set([
      base.releaseId,
      changedFile.releaseId,
      changedVersion.releaseId,
      changedRevision.releaseId,
    ])).toHaveLength(4);
  });

  it("拒绝未知字段、乱序文件和无法复算的 releaseId", () => {
    const manifest = createReleaseManifest({
      ...identity,
      files: [file("assets/a.css", "a"), file("assets/z.js", "b")],
      requireRevision: true,
    });

    expect(() => verifyReleaseManifest({ ...manifest, builtAt: new Date().toISOString() }, { requireRevision: true }))
      .toThrow("unsupported fields");
    expect(() => verifyReleaseManifest({ ...manifest, files: [...manifest.files].reverse() }, { requireRevision: true }))
      .toThrow("canonical path order");
    expect(() => verifyReleaseManifest({ ...manifest, releaseId: `sha256:${"0".repeat(64)}` }, { requireRevision: true }))
      .toThrow("does not match");
  });

  it("生产身份只接受安全版本和完整提交摘要", () => {
    expect(normalizePublicReleaseIdentity({ ...identity, requireRevision: true })).toEqual(identity);
    expect(() => normalizePublicReleaseIdentity({
      version: "release with host=/Users/operator",
      revision: identity.revision,
      requireRevision: true,
    })).toThrow("safe ASCII");
    expect(() => normalizePublicReleaseIdentity({
      version: identity.version,
      revision: "abcdef0",
      requireRevision: true,
    })).toThrow("complete lowercase Git commit");
  });
});
