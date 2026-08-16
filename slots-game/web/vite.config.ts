import { defineConfig } from "vitest/config";

function productionChunkName(moduleID: string): string | undefined {
  const id = moduleID.replaceAll("\\", "/");

  // 把体积较大且稳定的第三方渲染运行时拆成可独立缓存的块。启动壳必须先完成首屏，
  // 后续 AppController 再按同一依赖边界加载这些模块。
  if (id.includes("/node_modules/@pixi-spine/")) return "vendor-pixi-spine";
  if (id.includes("/node_modules/@pixi/") || id.includes("/node_modules/pixi.js/")) {
    return "vendor-pixi";
  }
  if (id.includes("/node_modules/")) return "vendor";

  // 给每个可独立交付的玩法区域设置确定下载/缓存边界；权威展示生命周期仍只由
  // AppController 统一装配，不改变业务顺序或结算规则。
  if (id.includes("/src/renderer/")) return "game-renderer";
  if (id.includes("/src/reels/")) return "game-reels";
  if (id.includes("/src/audio/")) return "game-audio";
  if (id.includes("/src/protocol/")) return "game-protocol";
  if (id.includes("/src/startup/")) return "game-startup";
  if (id.includes("/src/ui/")) return "game-ui";
  if (id.includes("/src/assets/")) return "game-assets";
  if (id.includes("/src/app/")) return "game-app";
  return undefined;
}

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 500,
    // 生产包不生成源码映射；既减少发布体积，也避免泄露本机路径和源码上下文。
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Vite 8 使用 Rolldown 显式分组。禁止把全部静态依赖递归吸入第一个匹配组，
          // 否则会重新形成该策略需要消除的 AppController 单体大包。
          includeDependenciesRecursively: false,
          groups: [
            {
              name: productionChunkName,
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
