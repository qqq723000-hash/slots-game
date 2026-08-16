const HOST_ORIGIN_ERROR = "RGS host origin must be an exact credential-free HTTPS origin";

/**
 * 只接受 URL 标准序列化后的精确 HTTPS 来源。拒绝通配符、凭据、路径及
 * query/hash，避免恢复通知被发送到构建配置之外的宿主。
 */
export function parseExactHttpsHostOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(HOST_ORIGIN_ERROR);
  }
  if (value === "*" || parsed.protocol !== "https:"
    || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
    || parsed.origin !== value) {
    throw new Error(HOST_ORIGIN_ERROR);
  }
  return parsed.origin;
}
