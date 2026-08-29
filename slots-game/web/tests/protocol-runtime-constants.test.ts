// @ts-nocheck -- 该契约测试同时验证 JavaScript 构建门禁。 / English: @ts-nocheck -- This contract test also verifies the JavaScript build gate.
import { describe, expect, it } from "vitest";

import {
  LOCKED_VAULT_FACES as applicationLockedVaultFaces,
  SYMBOL_IDS as applicationSymbolIds,
  WHEEL_INSTANT_MULTIPLIER_BY_TIER as applicationWheelMultipliers,
  lockedVaultFaceForOriginalServerId as applicationLockedVaultFace,
} from "../src/app/state/types";
import {
  LOCKED_VAULT_FACES,
  SYMBOL_IDS,
  WHEEL_INSTANT_MULTIPLIER_BY_TIER,
  lockedVaultFaceForOriginalServerId,
} from "../src/protocol/protocolConstants";
import {
  assertAcyclicStaticChunkGraph,
  staticModuleSpecifiers,
} from "../scripts/production-javascript-import-contract.mjs";

describe("协议运行时常量边界", () => {
  it("应用状态入口只重导出协议叶子模块的同一份运行时值", () => {
    expect(applicationSymbolIds).toBe(SYMBOL_IDS);
    expect(applicationLockedVaultFaces).toBe(LOCKED_VAULT_FACES);
    expect(applicationWheelMultipliers).toBe(WHEEL_INSTANT_MULTIPLIER_BY_TIER);
    expect(applicationLockedVaultFace).toBe(lockedVaultFaceForOriginalServerId);
    expect(new Set(SYMBOL_IDS)).toEqual(new Set([
      "ORBIT",
      "PRISM",
      "PULSE",
      "NOVA",
      "CIRCUIT",
      "TANK",
      "WILD",
      "VAULT",
      "SURGE",
    ]));
  });

  it("生产门禁提取全部静态导入形式并忽略动态导入及伪文本", () => {
    expect(staticModuleSpecifiers(`
      import value from "./default.js";
      export { named } from "./named.js";
      export * from "./star.js";
      import "./side-effect.js";
      const text = 'import "./string.js"';
      // 中文注释中的伪导入：import "./comment.js"; / English: Pseudo import in Chinese comments: import "./comment.js";
      void import("./dynamic.js");
    `)).toEqual([
      "./default.js",
      "./named.js",
      "./star.js",
      "./side-effect.js",
    ]);
  });

  it("生产门禁拒绝任意多节点静态循环和单节点自环", () => {
    expect(() => assertAcyclicStaticChunkGraph([
      {
        name: "a.js",
        source: 'import "./b.js";',
      },
      {
        name: "b.js",
        source: 'export * from "./a.js";',
      },
    ])).toThrow(/静态分块图存在循环依赖[\s\S]*a\.js -> b\.js[\s\S]*b\.js -> a\.js/);

    expect(() => assertAcyclicStaticChunkGraph([{
      name: "self.js",
      source: 'import "./self.js";',
    }])).toThrow(/self\.js -> self\.js/);
  });

  it("生产门禁允许包含静态重导出和副作用导入的无环图", () => {
    expect(() => assertAcyclicStaticChunkGraph([
      { name: "entry.js", source: 'export { value } from "./feature.js";' },
      { name: "feature.js", source: 'import "./runtime.js"; export const value = 1;' },
      { name: "runtime.js", source: "export const ready = true;" },
    ])).not.toThrow();
  });
});
