/**
 * 根据配置的部署基础解析从 Vite 的公共目录复制的文件。因此，Operator 构建可以位于 `/casino/primal/` 等路径下，
 * 而无需将运行时资产强制到原始根目录。
 *
 * 英文 / English: Parses files copied from Vite's public directory based on the configured deployment base. Therefore, Operator builds can be located under paths such as `/casino/primal/` without forcing runtime assets to the original root directory.
 */
export function publicAssetUrl(
  path: string,
  baseUrl: string = import.meta.env.BASE_URL || "/",
): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalizedBaseUrl}${path.replace(/^\/+/, "")}`;
}

const PUBLIC_ASSET_BASE_ORIGIN = "https://public-assets.invalid";

/**
 * 返回 Vite public 目录中 `assets/` 在给定部署基础下的 pathname 前缀。
 *
 * 该函数只处理路径边界；需要同源约束的调用方仍必须独立比较 URL origin。
 *
 * 英文 / English: Returns the pathname prefix of `assets/` in the Vite public directory for the given deployment. This function only handles path boundaries; callers requiring origin constraints must still compare URL origins independently.
 */
export function publicAssetPathPrefix(
  baseUrl: string = import.meta.env.BASE_URL || "/",
): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("assets/", new URL(normalizedBaseUrl, `${PUBLIC_ASSET_BASE_ORIGIN}/`)).pathname;
}

/** 防止安全校验把合法的 `/casino/primal/assets/...` 误判为非公开资源。 / English: Prevent the security check from misjudging legal `/casino/primal/assets/...` as non-public resources. */
export function isPublicAssetPathname(
  pathname: string,
  baseUrl: string = import.meta.env.BASE_URL || "/",
): boolean {
  return pathname.startsWith(publicAssetPathPrefix(baseUrl));
}
