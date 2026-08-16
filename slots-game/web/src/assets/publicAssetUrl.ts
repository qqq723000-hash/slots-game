const baseUrl = import.meta.env.BASE_URL || "/";
const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

/**
 * 根据配置的部署基础解析从 Vite 的公共目录复制的文件。因此，Operator 构建可以位于 `/casino/primal/` 等路径下，
 * 而无需将运行时资产强制到原始根目录。
 */
export function publicAssetUrl(path: string): string {
  return `${normalizedBaseUrl}${path.replace(/^\/+/, "")}`;
}
