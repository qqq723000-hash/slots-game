export const captureClockPauseLeadMs = 250;
export const captureClockPauseAttempts = 4;
export const captureClockPauseVerificationDelayMs = 16;
export const captureClockPastTargetMessage = "Cannot fast-forward to the past";

async function resumeCaptureClockAfterFailure(resume, originalError) {
  try {
    await resume();
  } catch (resumeError) {
    throw new AggregateError(
      [originalError, resumeError],
      "截图时钟恢复失败",
      { cause: originalError },
    );
  }
}

/**
 * 页面 guard 清理失败时，成功的暂停尚未交给调用方管理，因此必须先恢复时钟。
 * 已有暂停错误的路径由单次尝试 helper 负责恢复；此处保留原错误，不用清理错误覆盖它。
 *
 * 英文 / English: When page guard cleanup fails, the successful pause has not yet been handed over to the caller to manage, so the clock must be restored first. Paths with pause errors are restored by the single-try helper; the original error is retained here and does not overwrite it with cleanup errors.
 */
export async function clearCaptureClockPageGuardAfterPause({
  clearPageGuard,
  pauseError,
  resume,
}) {
  try {
    await clearPageGuard();
  } catch (cleanupError) {
    if (pauseError !== null) {
      throw new AggregateError(
        [pauseError, cleanupError],
        "截图时钟页面 guard 清理失败",
        { cause: pauseError },
      );
    }
    try {
      await resume();
    } catch (resumeError) {
      throw new AggregateError(
        [cleanupError, resumeError],
        "截图时钟页面 guard 清理与恢复失败",
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
}

export function isStableCaptureClockPauseObservation(
  pausedPageTimeMs,
  verifiedPausedPageTimeMs,
) {
  return Number.isFinite(pausedPageTimeMs)
    && Number.isFinite(verifiedPausedPageTimeMs)
    && Object.is(pausedPageTimeMs, verifiedPausedPageTimeMs);
}

export function isRecoverableCaptureClockPastTarget(
  error,
  pausedPageTimeMs,
  pauseTargetMs,
) {
  const [firstLine = ""] = String(error?.message ?? error).split(/\r?\n/, 1);
  const message = firstLine.trim();
  const matchesClockMessage = [
    `clock.pauseAt: ${captureClockPastTargetMessage}`,
    `clock.pauseAt: Error: ${captureClockPastTargetMessage}`,
  ].includes(message);
  return matchesClockMessage
    && Number.isFinite(pausedPageTimeMs)
    && Number.isFinite(pauseTargetMs)
    && pausedPageTimeMs > pauseTargetMs;
}

/**
 * 执行一次可注入、可确定性测试的暂停尝试。past-target 只有在第二次页面时间读数
 * 证明时钟已经冻结时才算成功；其余暂停后失败路径均先恢复时钟再返回或抛错。
 *
 * 英文 / English: Perform a paused attempt at an injectable, deterministic test. past-target is successful only when the second page time reading proves that the clock has been frozen; other failed paths after a pause will first restore the clock and then return or throw an error.
 */
export async function captureClockPauseAttempt({
  beginConsoleGuard,
  pauseAt,
  readPageTime,
  resume,
  settleConsoleGuard,
  waitForVerification,
}) {
  const pageTimeMs = await readPageTime();
  const pauseTargetMs = pageTimeMs + captureClockPauseLeadMs;
  beginConsoleGuard();
  let pauseError = null;
  try {
    await pauseAt(pauseTargetMs);
  } catch (error) {
    pauseError = error;
  }

  let pausedPageTimeMs = null;
  let clockStateReadError = null;
  try {
    pausedPageTimeMs = await readPageTime();
  } catch (error) {
    clockStateReadError = error;
  }
  const isPastTarget = clockStateReadError === null
    && isRecoverableCaptureClockPastTarget(pauseError, pausedPageTimeMs, pauseTargetMs);

  let verifiedPausedPageTimeMs = null;
  let clockPauseVerificationReadError = null;
  if (isPastTarget) {
    try {
      await waitForVerification(captureClockPauseVerificationDelayMs);
      verifiedPausedPageTimeMs = await readPageTime();
    } catch (error) {
      clockPauseVerificationReadError = error;
    }
  }
  let consoleGuardSettlementError = null;
  try {
    settleConsoleGuard(isPastTarget);
  } catch (error) {
    consoleGuardSettlementError = error;
  }

  if (consoleGuardSettlementError !== null) {
    await resumeCaptureClockAfterFailure(resume, consoleGuardSettlementError);
    throw consoleGuardSettlementError;
  }

  if (clockStateReadError !== null) {
    await resumeCaptureClockAfterFailure(resume, clockStateReadError);
    throw clockStateReadError;
  }
  if (pauseError === null) {
    return Object.freeze({ paused: true, pastTargetError: null });
  }
  if (clockPauseVerificationReadError !== null) {
    await resumeCaptureClockAfterFailure(resume, clockPauseVerificationReadError);
    throw clockPauseVerificationReadError;
  }
  if (isPastTarget && isStableCaptureClockPauseObservation(
    pausedPageTimeMs,
    verifiedPausedPageTimeMs,
  )) {
    return Object.freeze({ paused: true, pastTargetError: null });
  }

  await resumeCaptureClockAfterFailure(resume, pauseError);
  if (!isPastTarget) throw pauseError;
  return Object.freeze({ paused: false, pastTargetError: pauseError });
}

/** 有界重试只接受 helper 明确证明的暂停态，并保留最后一次 past-target 原因。 / English: Bounded retries only accept paused states explicitly certified by the helper, and retain the last past-target reason. */
export async function captureClockPauseWithAttempts(attemptPause) {
  let lastPastTargetError = null;
  for (let attempt = 0; attempt < captureClockPauseAttempts; attempt += 1) {
    const result = await attemptPause();
    if (result.paused) return;
    lastPastTargetError = result.pastTargetError;
  }
  throw new Error(
    `特殊玩法截图时钟连续 ${captureClockPauseAttempts} 次无法在当前页面时刻暂停`,
    { cause: lastPastTargetError },
  );
}
