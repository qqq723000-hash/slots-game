// @ts-nocheck -- 构建期字节合同直接读取 HTML/Git 属性并调用 Node 校验器。
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  REVIEWED_INLINE_SCRUB_CSP_SOURCE,
  verifyReviewedIndexSource,
} from "../scripts/verify-browser-preflight-build.mjs";

const indexUrl = new URL("../index.html", import.meta.url);
const attributesUrl = new URL("../../.gitattributes", import.meta.url);

describe("browser preflight build byte contract", () => {
  it("accepts only the reviewed LF inline scrub bytes", async () => {
    const indexSource = await readFile(indexUrl, "utf8");
    expect(indexSource).not.toContain("\r\n");
    expect(verifyReviewedIndexSource(indexSource)).toMatchObject({
      inlineScrubCspSource: REVIEWED_INLINE_SCRUB_CSP_SOURCE,
      preflightUrl: "%BASE_URL%browser-preflight.js",
    });
  });

  it("does not ignore an injected uppercase SCRIPT candidate", async () => {
    const indexSource = await readFile(indexUrl, "utf8");
    const canonicalOpeningTag = '<script id="launch-fragment-scrub">';
    expect(indexSource.split(canonicalOpeningTag)).toHaveLength(2);
    const uppercaseCandidate = indexSource.replace(
      canonicalOpeningTag,
      `<SCRIPT src="/unexpected.js"></SCRIPT>\n    ${canonicalOpeningTag}`,
    );

    expect(() => verifyReviewedIndexSource(uppercaseCandidate)).toThrow(
      "生产 HTML 必须且只能依次执行内联片段清理",
    );
  });

  it("does not ignore a script candidate with closing-tag whitespace", async () => {
    const indexSource = await readFile(indexUrl, "utf8");
    const canonicalOpeningTag = '<script id="launch-fragment-scrub">';
    expect(indexSource.split(canonicalOpeningTag)).toHaveLength(2);
    const whitespaceClosingCandidate = indexSource.replace(
      canonicalOpeningTag,
      `<script src="/unexpected.js"></script >\n    ${canonicalOpeningTag}`,
    );

    expect(() => verifyReviewedIndexSource(whitespaceClosingCandidate)).toThrow(
      "生产 HTML 必须且只能依次执行内联片段清理",
    );
  });

  it("rejects simulated Windows CRLF bytes and pins text checkout to LF", async () => {
    const [indexSource, attributes] = await Promise.all([
      readFile(indexUrl, "utf8"),
      readFile(attributesUrl, "utf8"),
    ]);
    const crlfIndexSource = indexSource.replace(/\n/gu, "\r\n");

    expect(crlfIndexSource).toContain("\r\n");
    expect(() => verifyReviewedIndexSource(crlfIndexSource)).toThrow(
      "生产内联片段清理器字节与审核过的 CSP hash 不一致",
    );
    expect(attributes.split(/\r?\n/u)).toContain("* text=auto eol=lf");
  });
});
