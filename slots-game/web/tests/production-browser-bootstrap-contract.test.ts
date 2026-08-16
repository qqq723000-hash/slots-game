// @ts-nocheck -- 该契约测试需要在 Node 中读取构建配置与仓库级门禁文件。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../vite.config";

interface ChunkGroup {
  readonly name: string | ((moduleID: string) => string | undefined);
  readonly test?: string | RegExp | ((moduleID: string) => boolean);
  readonly priority?: number;
  readonly maxSize?: number;
}

const configObject = typeof config === "function"
  ? config({ command: "build", mode: "production", isSsrBuild: false, isPreview: false })
  : config;
const output = configObject.build?.rolldownOptions?.output;
if (Array.isArray(output)) throw new Error("生产构建不得使用多套输出分块配置");
const splitting = output?.codeSplitting;
if (!splitting || typeof splitting !== "object") throw new Error("生产构建缺少显式分块配置");
const groups = (splitting.groups ?? []) as ChunkGroup[];

function matchingGroup(moduleID: string): ChunkGroup | undefined {
  return groups
    .filter((group) => matches(group.test, moduleID))
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0];
}

function matches(test: ChunkGroup["test"], moduleID: string): boolean {
  if (test === undefined) return true;
  if (typeof test === "string") return moduleID.includes(test);
  if (test instanceof RegExp) return test.test(moduleID);
  return test(moduleID);
}

function chunkName(group: ChunkGroup | undefined, moduleID: string): string | undefined {
  if (!group) return undefined;
  return typeof group.name === "function" ? group.name(moduleID) : group.name;
}

describe("production browser bootstrap contract", () => {
  it("keeps initialization-sensitive dependency families in unsliced chunks", () => {
    const pixiSettings = "/repo/node_modules/@pixi/settings/dist/esm/settings.mjs";
    const pixiDisplay = "/repo/node_modules/@pixi/display/dist/esm/display.mjs";
    const spineBase = "/repo/node_modules/@pixi-spine/base/lib/index.js";
    const spineRuntime = "/repo/node_modules/@pixi-spine/runtime-4.1/lib/index.js";
    const renderer = "/repo/src/renderer/GameRenderer.ts";
    const reels = "/repo/src/reels/ReelController.ts";

    for (const [left, right, expectedName] of [
      [pixiSettings, pixiDisplay, "vendor-pixi"],
      [spineBase, spineRuntime, "vendor-pixi-spine"],
      [renderer, reels, "game-rendering"],
    ] as const) {
      const leftGroup = matchingGroup(left);
      const rightGroup = matchingGroup(right);
      expect(leftGroup).toBe(rightGroup);
      expect(chunkName(leftGroup, left)).toBe(expectedName);
      expect(leftGroup?.maxSize).toBeUndefined();
    }
  });

  it("retains the bounded split for modules outside known dependency cycles", () => {
    const protocol = "/repo/src/protocol/RgsGateway.ts";
    const group = matchingGroup(protocol);
    expect(chunkName(group, protocol)).toBe("game-protocol");
    expect(group?.maxSize).toBe(450_000);
  });

  it("wires the real-browser gate into package, local verification and CI", () => {
    const packageJSON = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const makefile = readFileSync(new URL("../../Makefile", import.meta.url), "utf8");
    const workflow = readFileSync(
      new URL("../../../.github/workflows/frontend-conformance.yml", import.meta.url),
      "utf8",
    );
    const smoke = readFileSync(
      new URL("../scripts/verify-production-browser-bootstrap.mjs", import.meta.url),
      "utf8",
    );

    expect(packageJSON.scripts["build:browser-smoke"])
      .toBe("node scripts/verify-production-browser-bootstrap.mjs");
    expect(makefile).toContain("verify-web-browser-bootstrap:");
    expect(makefile).toContain("npm run build:browser-smoke");
    expect(workflow).toContain("npm run build:browser-smoke");
    expect(smoke).toContain('"--headless=new"');
    expect(smoke).toContain('send("Runtime.evaluate"');
    expect(smoke).toContain("await import(url)");
  });
});
