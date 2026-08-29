// @ts-nocheck -- 仅在 Node 中运行的静态入口与二进制资源契约测试。 / English: @ts-nocheck -- Static entry and binary resource contract tests that only run in Node.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";

const favicon = readFileSync(new URL("../public/favicon.ico", import.meta.url));
const sourceLogo = readFileSync(
  new URL("../public/assets/primal-reference/primal-rampage-logo.png", import.meta.url),
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes: Buffer): readonly [number, number] {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function icoSizes(bytes: Buffer): number[] {
  expect(bytes.readUInt16LE(0)).toBe(0);
  expect(bytes.readUInt16LE(2)).toBe(1);
  const count = bytes.readUInt16LE(4);

  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    const widthByte = bytes.readUInt8(offset);
    const heightByte = bytes.readUInt8(offset + 1);
    const width = widthByte === 0 ? 256 : widthByte;
    const height = heightByte === 0 ? 256 : heightByte;

    expect(height).toBe(width);
    expect(bytes.readUInt16LE(offset + 4)).toBe(1);
    expect(bytes.readUInt16LE(offset + 6)).toBe(32);
    expect(bytes.readUInt32LE(offset + 8)).toBeGreaterThan(0);
    expect(bytes.readUInt32LE(offset + 12)).toBeLessThan(bytes.byteLength);

    return width;
  });
}

describe("Pass 137 official provider browser-tab icon", () => {
  it("declares exactly one public-base-aware ICO entrypoint", () => {
    expect(indexHtml.match(/rel="icon"/g)).toHaveLength(1);
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/x-icon" href="%BASE_URL%favicon.ico" sizes="any" />',
    );
  });

  it("locks the exact captured Primal Rampage source logo", () => {
    expect(pngDimensions(sourceLogo)).toEqual([260, 162]);
    expect(sourceLogo.byteLength).toBe(68_780);
    expect(sha256(sourceLogo)).toBe(
      "f7f59338d12fea0f30f41d49e83fceec8595a78f8ec5c6aac7f88b751148118f",
    );
  });

  it("ships the exact six-size, 32-bit red GO favicon approved by the asset gate", () => {
    expect(favicon.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
    expect(icoSizes(favicon).sort((a, b) => a - b)).toEqual([16, 32, 48, 64, 128, 256]);
    expect(favicon.byteLength).toBe(370_070);
    expect(sha256(favicon)).toBe(
      "9871915e932f969bd5b733083f76dbe80b5e1fa1a36aac18da6411b8da1491ac",
    );
  });
});
