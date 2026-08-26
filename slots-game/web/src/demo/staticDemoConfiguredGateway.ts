import type { GameGateway } from "../protocol/GameGateway";

/**
 * 仅供 vite.demo.config.ts 使用的编译期替换。如果未来 Demo 入口忘记注入固定网关，
 * 必须失败关闭，不能打开 RGS、读取启动交接字段或选择网络回退。
 */
export function createConfiguredGameGateway(_options: unknown): GameGateway {
  throw new Error("RGS transport is unavailable in the static demo build");
}

/** 静态 Demo 永不打开或探测生产恢复账本。 */
export function optionalWindowSessionStorage(_windowValue: Window): null {
  return null;
}
