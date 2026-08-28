export const captureClockPauseLeadMs = 250;
export const captureClockPauseAttempts = 4;
export const captureClockPastTargetMessage = "Cannot fast-forward to the past";

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
