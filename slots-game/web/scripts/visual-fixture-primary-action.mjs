const primaryActionLeaseFields = Object.freeze([
  "sequence",
  "stage",
  "milestone",
  "milestoneCount",
  "event",
  "featureMode",
  "spinAction",
  "spinMode",
]);

export function primaryActionLeaseFromSnapshot(snapshot) {
  return Object.freeze(Object.fromEntries(primaryActionLeaseFields.map(
    (field) => [field, snapshot?.[field] ?? null],
  )));
}

export function primaryActionLeaseKey(lease) {
  return JSON.stringify(primaryActionLeaseFields.map((field) => lease?.[field] ?? null));
}

export function primaryActionLeaseSelector(lease) {
  const bodySelector = [
    ["data-fixture-sequence", lease?.sequence ?? null],
    ["data-fixture-stage", lease?.stage ?? null],
    ["data-fixture-milestone", lease?.milestone ?? null],
    [
      "data-fixture-milestone-count",
      lease?.milestoneCount === 0 ? null : lease?.milestoneCount ?? null,
    ],
    ["data-fixture-event", lease?.event ?? null],
  ].map(([name, value]) => cssAttributeCondition(name, value)).join("");
  const spinSelector = [
    ["data-role", "spin"],
    ["data-action", lease?.spinAction ?? null],
    ["data-mode", lease?.spinMode ?? null],
  ].map(([name, value]) => cssAttributeCondition(name, value)).join("");
  return `body${bodySelector} ${spinSelector}`;
}

export function primaryActionLeaseMatchesSnapshot(expectedLease, snapshot) {
  if (snapshot?.spinDisabled !== false) return false;
  const currentLease = primaryActionLeaseFromSnapshot(snapshot);
  return primaryActionLeaseFields.every(
    (field) => Object.is(expectedLease?.[field] ?? null, currentLease[field]),
  );
}

export function isPlaywrightLocatorClickTimeout(error, timeoutMs) {
  if (error?.name !== "TimeoutError" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return false;
  }
  const [firstLine = ""] = String(error.message ?? "").split(/\r?\n/, 1);
  return firstLine.trim() === `locator.click: Timeout ${timeoutMs}ms exceeded.`;
}

export async function clickWithPrimaryActionLease({
  attemptClick,
  attemptTimeoutMs,
  expectedLease,
  now = Date.now,
  readSnapshot,
  totalTimeoutMs,
}) {
  if (typeof attemptClick !== "function"
    || typeof readSnapshot !== "function"
    || typeof now !== "function"
    || !Number.isSafeInteger(attemptTimeoutMs)
    || attemptTimeoutMs <= 0
    || !Number.isSafeInteger(totalTimeoutMs)
    || totalTimeoutMs <= attemptTimeoutMs) {
    throw new Error("主控件输入租约参数无效");
  }

  const startedAt = now();
  const maximumAttempts = Math.ceil(totalTimeoutMs / attemptTimeoutMs);
  let attemptCount = 0;
  let lastTimeoutError = null;
  while (true) {
    const beforeAttempt = await readSnapshot();
    if (!primaryActionLeaseMatchesSnapshot(expectedLease, beforeAttempt)) return false;

    const remainingMs = totalTimeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      if (lastTimeoutError) throw lastTimeoutError;
      throw new Error(`主控件输入租约在 ${totalTimeoutMs}ms 内未获得点击尝试时间`);
    }
    const boundedAttemptTimeoutMs = Math.max(1, Math.min(attemptTimeoutMs, remainingMs));
    attemptCount += 1;
    try {
      await attemptClick(boundedAttemptTimeoutMs);
      return true;
    } catch (error) {
      if (!isPlaywrightLocatorClickTimeout(error, boundedAttemptTimeoutMs)) throw error;
      lastTimeoutError = error;
      const afterAttempt = await readSnapshot();
      if (!primaryActionLeaseMatchesSnapshot(expectedLease, afterAttempt)) return false;
      if (now() - startedAt >= totalTimeoutMs || attemptCount >= maximumAttempts) throw error;
    }
  }
}

function cssAttributeCondition(name, value) {
  if (value === null) return `:not([${name}])`;
  const escapedValue = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\d ")
    .replace(/\n/g, "\\a ");
  return `[${name}="${escapedValue}"]`;
}
