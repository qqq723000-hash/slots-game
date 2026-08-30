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

export function primaryActionTrustedPointerTarget(evidence) {
  const rectangle = evidence?.rectangle;
  const viewport = evidence?.viewport;
  const centerX = rectangle?.left + rectangle?.width / 2;
  const centerY = rectangle?.top + rectangle?.height / 2;
  const safe = evidence?.matchCount === 1
    && evidence?.spinCount === 1
    && evidence?.leaseMatched === true
    && evidence?.connected === true
    && evidence?.disabled === false
    && evidence?.hidden === false
    && evidence?.display !== "none"
    && evidence?.visibility !== "hidden"
    && evidence?.visibility !== "collapse"
    && Number.isFinite(evidence?.opacity)
    && evidence.opacity > 0
    && evidence?.pointerEvents !== "none"
    && Number.isFinite(rectangle?.left)
    && Number.isFinite(rectangle?.top)
    && Number.isFinite(rectangle?.width)
    && Number.isFinite(rectangle?.height)
    && rectangle.width > 0
    && rectangle.height > 0
    && Number.isFinite(viewport?.width)
    && Number.isFinite(viewport?.height)
    && viewport.width > 0
    && viewport.height > 0
    && Number.isFinite(evidence?.visibleAreaRatio)
    && evidence.visibleAreaRatio >= 0.995
    && Number.isFinite(centerX)
    && Number.isFinite(centerY)
    && centerX >= 0
    && centerX <= viewport.width
    && centerY >= 0
    && centerY <= viewport.height
    && evidence?.centerHitTarget === true;
  if (!safe) {
    throw new Error(`主控件 trusted pointer 目标不可安全点击：${JSON.stringify(evidence)}`);
  }
  return Object.freeze({ x: centerX, y: centerY });
}

export function primaryActionTrustedPointerGuardDecision(result) {
  if (result?.observed !== true) {
    throw new Error(`主控件 trusted pointer 事件未被租约守卫观察：${JSON.stringify(result)}`);
  }
  if (result.isTrusted !== true) {
    throw new Error(`主控件 trusted pointer 事件证据无效：${JSON.stringify(result)}`);
  }
  if (result.targetMatched !== true) {
    throw new Error(`主控件 trusted pointer 事件证据无效：${JSON.stringify(result)}`);
  }
  if (result.leaseMatched !== true) return "stale";
  return "accepted";
}

export async function clickWithPrimaryActionLease({
  attemptClick,
  expectedLease,
  now = Date.now,
  readSnapshot,
  totalTimeoutMs,
  waitForNextObservation,
}) {
  if (typeof attemptClick !== "function"
    || typeof readSnapshot !== "function"
    || typeof now !== "function"
    || typeof waitForNextObservation !== "function"
    || !Number.isSafeInteger(totalTimeoutMs)
    || totalTimeoutMs <= 0) {
    throw new Error("主控件输入租约参数无效");
  }

  const startedAt = now();
  const beforeEvent = await readSnapshot();
  if (!primaryActionLeaseMatchesSnapshot(expectedLease, beforeEvent)) return false;
  const beforeEventRemainingMs = totalTimeoutMs - (now() - startedAt);
  if (beforeEventRemainingMs <= 0) {
    throw new Error(`主控件输入租约在 ${totalTimeoutMs}ms 内未获得 trusted pointer 时间`);
  }

  // 回调必须先安装事件时刻的租约守卫，再发出可信指针；陈旧租约只有在 / English: The callback must first install the lease guard at the event time before issuing a trusted pointer; the stale lease can only be
  // 阻断该事件后才能返回 false。 / English: Return false only after blocking the event.
  const eventAccepted = await attemptClick(beforeEventRemainingMs);
  if (eventAccepted === false) return false;
  if (eventAccepted !== true) {
    throw new Error("主控件 trusted pointer 回执无效");
  }

  while (true) {
    const afterEvent = await readSnapshot();
    if (!primaryActionLeaseMatchesSnapshot(expectedLease, afterEvent)) return true;
    const remainingMs = totalTimeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(`主控件 trusted pointer 在 ${totalTimeoutMs}ms 内未消费精确输入租约`);
    }
    await waitForNextObservation(Math.min(16, remainingMs));
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
