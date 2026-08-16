export const NETWORK_RESPONSE_LIMITS = Object.freeze({
  /** RGS 的权威 JSON 响应；与协议解码器原有 4 MiB 上限保持一致。 */
  rgsJsonBytes: 4 * 1024 * 1024,
  /** 流式资源清单；当前产物不足 32 KiB，保留版本扩展余量。 */
  streamingManifestBytes: 2 * 1024 * 1024,
  /** 单个经清单签名约束的资源；同时约束网络读取与瞬时堆占用。 */
  assetPackageResourceBytes: 16 * 1024 * 1024,
  /** 单个音频包；当前最大产物不足 3 MiB。 */
  audioAssetBytes: 8 * 1024 * 1024,
  /** Spine 二进制骨骼；当前最大产物不足 512 KiB。 */
  spineBinaryBytes: 4 * 1024 * 1024,
  /** Spine atlas、BMFont 与小型渲染清单的文本上限。 */
  rendererTextBytes: 1024 * 1024,
} as const);

export interface BoundedResponseReadOptions {
  readonly label: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (receivedBytes: number) => void;
}

/** 表示远端响应越过本地硬字节边界；错误不得携带 URL、响应正文或凭据。 */
export class NetworkResponseLimitError extends Error {
  constructor(
    readonly label: string,
    readonly limitBytes: number,
    readonly receivedBytes: number | null,
    readonly declaredBytes: number | null,
  ) {
    super(`${label} exceeds the ${limitBytes}-byte safety limit`);
    this.name = "NetworkResponseLimitError";
  }
}

export class NetworkResponseBodyError extends Error {
  constructor(readonly label: string, message: string) {
    super(`${label} ${message}`);
    this.name = "NetworkResponseBodyError";
  }
}

/**
 * 有界读取 Fetch 响应。Content-Length 仅用于提前拒绝和初始容量规划；
 * 真正边界始终由流式累计字节数执行，防止 chunked 或伪造长度绕过。
 */
export async function readBoundedResponseBytes(
  response: Response,
  options: Readonly<BoundedResponseReadOptions>,
): Promise<Uint8Array> {
  const maxBytes = checkedLimit(options.maxBytes);
  throwIfAborted(options.signal);
  const declaredBytes = declaredContentLength(response.headers);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    const error = new NetworkResponseLimitError(
      options.label,
      maxBytes,
      null,
      declaredBytes,
    );
    cancelNetworkResponse(response, error);
    throw error;
  }

  if (!response.body) {
    if (
      declaredBytes === 0
      || response.status === 204
      || response.status === 205
      || response.status === 304
    ) {
      return new Uint8Array(0);
    }
    // 无 ReadableStream 时 arrayBuffer()/text() 无法在分配前实施硬上限，必须故障关闭。
    throw new NetworkResponseBodyError(
      options.label,
      "does not expose a bounded streaming body",
    );
  }

  const reader = response.body.getReader();
  const initialCapacity = Math.min(
    maxBytes,
    declaredBytes ?? Math.min(maxBytes, 16 * 1024),
  );
  let result = new Uint8Array(initialCapacity);
  let total = 0;
  let readerCancelled = false;
  const cancelForAbort = (): void => {
    void reader.cancel(abortReason(options.signal)).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancelForAbort, { once: true });
  try {
    for (;;) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();
      throwIfAborted(options.signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - total) {
        const error = new NetworkResponseLimitError(
          options.label,
          maxBytes,
          total + value.byteLength,
          declaredBytes,
        );
        // 在保存越界分块前立即取消底层流，避免继续下载或扩大堆占用。
        cancelReader(reader, error);
        readerCancelled = true;
        throw error;
      }
      const nextTotal = total + value.byteLength;
      if (nextTotal > result.byteLength) {
        result = growBuffer(result, nextTotal, maxBytes);
      }
      result.set(value, total);
      total = nextTotal;
      options.onProgress?.(total);
    }
  } catch (error) {
    if (!readerCancelled) {
      cancelReader(reader, error instanceof Error ? error : new Error("response read failed"));
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }

  return total === result.byteLength ? result : result.slice(0, total);
}

export async function readBoundedResponseArrayBuffer(
  response: Response,
  options: Readonly<BoundedResponseReadOptions>,
): Promise<ArrayBuffer> {
  const bytes = await readBoundedResponseBytes(response, options);
  return bytes.buffer;
}

export async function readBoundedResponseText(
  response: Response,
  options: Readonly<BoundedResponseReadOptions>,
): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, options);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NetworkResponseBodyError(options.label, "is not valid UTF-8");
  }
}

function checkedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("response maxBytes must be a non-negative safe integer");
  }
  return value;
}

function declaredContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function growBuffer(
  current: Uint8Array,
  requiredBytes: number,
  maxBytes: number,
): Uint8Array {
  let capacity = Math.max(1, current.byteLength);
  while (capacity < requiredBytes) {
    capacity = Math.min(maxBytes, Math.max(requiredBytes, capacity * 2));
  }
  const next = new Uint8Array(capacity);
  next.set(current);
  return next;
}

/** 无需解析正文的失败响应也应立即释放，避免错误页占用连接与带宽。 */
export function cancelNetworkResponse(response: Response, reason: Error): void {
  if (!response.body) return;
  try {
    void response.body.cancel(reason).catch(() => undefined);
  } catch {
    // 本地边界错误优先；取消失败不得覆盖首要故障，也不得继续读取正文。
  }
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: Error,
): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // 同上：保留确定、脱敏的边界错误。
  }
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("Network response read was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  const reason = abortReason(signal);
  if (reason instanceof Error) throw reason;
  const error = new Error("Network response read was aborted");
  error.name = "AbortError";
  throw error;
}
