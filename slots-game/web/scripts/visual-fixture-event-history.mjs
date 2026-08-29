export const visualFixtureEventHistoryLimit = 256;

function validEventType(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9_.-]+$/.test(value);
}

/**
 * 浏览器门禁只接受夹具实时发布的有界历史。返回稳定错误码而不是修复输入，
 * 这样丢字段、截断和 current/last 漂移都会使证据失败关闭。
 *
 * 英文 / English: The browser gatekeeper only accepts a bounded history of fixture live releases. Return stable error codes instead of fixing input, so that missing fields, truncation, and current/last drift can cause evidence to fail to close.
 */
export function visualFixtureEventHistorySnapshotViolation(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.events)) {
    return "event-history-structure";
  }
  if (!Number.isSafeInteger(snapshot.eventCount)
    || snapshot.eventCount < 0
    || snapshot.eventCount > visualFixtureEventHistoryLimit
    || snapshot.events.length !== snapshot.eventCount) {
    return "event-history-count";
  }
  if (!snapshot.events.every(validEventType)) return "event-history-entry";
  if (snapshot.event !== null
    && (!validEventType(snapshot.event) || snapshot.events.at(-1) !== snapshot.event)) {
    return "event-history-current-last";
  }
  return null;
}
