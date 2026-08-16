import type { MoneyMinor } from "../app/state/types";

export const PROTOCOL_VERSION = 1 as const;
export const ENGINE_RULES_VERSION = "slots-game-ways3-features-v4" as const;

export interface SessionOpenMessage {
  type: "session.open";
  protocolVersion: 1;
  engineRulesVersion: typeof ENGINE_RULES_VERSION;
  requestId: string;
  resumeSessionId?: string;
}

export interface SpinMessage {
  type: "spin";
  protocolVersion: 1;
  requestId: string;
  sessionId: string;
  roundId: string;
  betMinor: MoneyMinor;
}

export type RetriableSpinMessage = Omit<SpinMessage, "sessionId">;

/**
 * request/round 标识参与幂等与恢复，禁止从时钟或非密码学随机源派生。
 */
export class SecureRandomUnavailableError extends Error {
  constructor(message = "Web Crypto secure random generation is unavailable") {
    super(message);
    this.name = "SecureRandomUnavailableError";
  }
}

export function createRequestId(prefix: string): string {
  const crypto = globalThis.crypto;
  const id = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : createRandomUuidV4(crypto);
  return `${prefix}-${id}`;
}

function createRandomUuidV4(crypto: Crypto | undefined): string {
  if (typeof crypto?.getRandomValues !== "function") {
    throw new SecureRandomUnavailableError();
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    throw new SecureRandomUnavailableError("Web Crypto secure random generation failed");
  }
  // 按 RFC 4122 4.4 设置 version 4 与 variant 位；不得使用时间或 Math.random 回退。
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createSessionOpenMessage(resumeSessionId?: string): SessionOpenMessage {
  const message: SessionOpenMessage = {
    type: "session.open",
    protocolVersion: PROTOCOL_VERSION,
    engineRulesVersion: ENGINE_RULES_VERSION,
    requestId: createRequestId("session"),
  };
  if (resumeSessionId) message.resumeSessionId = resumeSessionId;
  return message;
}

export function renewSpinRequestId(message: RetriableSpinMessage): RetriableSpinMessage {
  return { ...message, requestId: createRequestId("spin") };
}
