import { defineConfig } from "vitest/config";

// 与公开支持矩阵保持逐字节一致；不要依赖 Vite 大版本会变化的隐式默认值。
export const PRODUCTION_BROWSER_TARGETS = Object.freeze([
  "chrome111",
  "edge111",
  "firefox114",
  "safari16.4",
  "ios16.4",
]);

function normalizedModuleID(moduleID: string): string {
  return moduleID.replaceAll("\\", "/");
}

function isPixiSpineModule(moduleID: string): boolean {
  return normalizedModuleID(moduleID).includes("/node_modules/@pixi-spine/");
}

function isPixiModule(moduleID: string): boolean {
  const id = normalizedModuleID(moduleID);
  return id.includes("/node_modules/@pixi/") || id.includes("/node_modules/pixi.js/");
}

function isRenderingCycleModule(moduleID: string): boolean {
  const id = normalizedModuleID(moduleID);
  return id.includes("/src/renderer/") || id.includes("/src/reels/");
}

function boundedProductionChunkName(moduleID: string): string | undefined {
  const id = normalizedModuleID(moduleID);
  if (id.includes("/node_modules/")) return "vendor";
  if (id.includes("/src/audio/")) return "game-audio";
  if (id.includes("/src/protocol/")) return "game-protocol";
  if (id.includes("/src/startup/")) return "game-startup";
  if (id.includes("/src/ui/")) return "game-ui";
  if (id.includes("/src/assets/")) return "game-assets";
  // AppController 的动态入口外壳不能独占 presentation 依赖，否则外壳重导出
  // game-app 的同时会被 game-app 反向导入，形成浏览器静态初始化循环。
  if (id.includes("/src/app/") || id.includes("/src/presentation/")) return "game-app";
  return undefined;
}

export default defineConfig({
  build: {
    target: [...PRODUCTION_BROWSER_TARGETS],
    cssTarget: [...PRODUCTION_BROWSER_TARGETS],
    chunkSizeWarningLimit: 500,
    // 生产包不生成源码映射；既减少发布体积，也避免泄露本机路径和源码上下文。
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            {
              // Pixi 与 Spine 都包含包内初始化顺序约束，必须按完整依赖族交付，
              // 禁止再按字节上限把同一依赖族切成互相循环的浏览器模块。
              name: "vendor-pixi-spine",
              test: isPixiSpineModule,
              includeDependenciesRecursively: false,
              minSize: 1,
              priority: 30,
            },
            {
              name: "vendor-pixi",
              test: isPixiModule,
              includeDependenciesRecursively: false,
              minSize: 1,
              priority: 20,
            },
            {
              // renderer 与 reels 互相引用展示状态，属于同一个模块强连通分量；
              // 同块求值可保持 free-spin 等导出的原始初始化顺序。
              name: "game-rendering",
              test: isRenderingCycleModule,
              includeDependenciesRecursively: false,
              minSize: 1,
              priority: 10,
            },
            {
              name: boundedProductionChunkName,
              includeDependenciesRecursively: false,
              minSize: 1,
              maxSize: 450_000,
            },
          ],
        },
      },
    },
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 端到端引擎夹具占用有限的本地端口和子进程；测试文件串行调度可消除跨文件
    // 启动竞态，各测试内部仍可执行自身安全的异步工作。
    fileParallelism: false,
  },
});
