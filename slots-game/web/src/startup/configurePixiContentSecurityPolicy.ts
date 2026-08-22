import { ShaderSystem } from "@pixi/core";
import { install as installStaticUniformSynchronization } from "@pixi/unsafe-eval";

let configured = false;

/**
 * 使用静态统一变量同步器，避免 Pixi 在运行时构造函数，从而保持严格的生产 CSP。
 */
export function configurePixiContentSecurityPolicy(): void {
  if (configured) return;
  installStaticUniformSynchronization({ ShaderSystem });
  configured = true;
}
