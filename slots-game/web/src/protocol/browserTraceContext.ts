const TRACE_PARENT_RANDOM_FLAG = "02";
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

export type CryptographicRandomFill = (target: Uint8Array) => void;

function defaultRandomFill(target: Uint8Array): void {
  const cryptography = globalThis.crypto;
  if (!cryptography || typeof cryptography.getRandomValues !== "function") {
    throw new Error("browser cryptographic randomness is unavailable");
  }
  cryptography.getRandomValues(target);
}

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((value) => value === 0);
}

/**
 * 每个浏览器请求生成独立的 W3C Trace Context，不使用玩家、会话、轮次、设备或持久存储。
 * 随机源不可用时只关闭诊断关联；经济请求本身不得因此失败。
 *
 * 英文 / English: Each browser request generates an independent W3C Trace Context and does not use players, sessions, rounds, devices or persistent storage. Only diagnostic correlation is turned off when the random source is unavailable; the economic request itself must not fail as a result.
 */
export function createBrowserTraceParent(
  fillRandom: CryptographicRandomFill = defaultRandomFill,
): string | null {
  const random = new Uint8Array(TRACE_ID_BYTES + SPAN_ID_BYTES);
  try {
    fillRandom(random);
  } catch {
    return null;
  }
  const traceId = random.subarray(0, TRACE_ID_BYTES);
  const spanId = random.subarray(TRACE_ID_BYTES);
  if (allZero(traceId) || allZero(spanId)) return null;
  return `00-${hexadecimal(traceId)}-${hexadecimal(spanId)}-${TRACE_PARENT_RANDOM_FLAG}`;
}

export function browserTraceHeaders(): Readonly<Record<string, string>> {
  const traceParent = createBrowserTraceParent();
  return traceParent ? Object.freeze({ traceparent: traceParent }) : Object.freeze({});
}
