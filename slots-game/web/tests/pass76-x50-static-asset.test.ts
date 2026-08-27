// @ts-nocheck -- 用于校验不可变且已提取的官方 PNG 资源。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const X50_STATIC_ASSET = resolve(process.cwd(), "public/assets/primal-reference/wild-x50.png");

describe("Pass76 official static x50 Wild asset", () => {
  it("ships the full packaged Paytable frame rather than the cropped placeholder", () => {
    const png = readFileSync(X50_STATIC_ASSET);

    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    // PNG 的 IHDR 从第 8 字节开始，宽度和高度从第 16 字节开始。
    expect(png.readUInt32BE(16)).toBe(200);
    expect(png.readUInt32BE(20)).toBe(170);
    expect(createHash("sha256").update(png).digest("hex"))
      .toBe("14e2dccb89ceadb59f49b14f2e69282770cd94c53761c84a005ae44e93870fbf");
  });
});
