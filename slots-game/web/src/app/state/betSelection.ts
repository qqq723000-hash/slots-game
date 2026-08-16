import type { FeatureState, MoneyMinor } from "./types";

export interface SessionBetSelection {
  betOptionsMinor: MoneyMinor[];
  defaultBetMinor: MoneyMinor;
  featureState: FeatureState;
}

export function featureLockedBet(featureState: FeatureState, fallback: MoneyMinor): MoneyMinor {
  if (featureState.freeSpinsRemaining > 0 && featureState.baseBetMinor) {
    return featureState.baseBetMinor;
  }
  return fallback;
}

export function selectSessionBet(
  session: SessionBetSelection,
  previousBetMinor: MoneyMinor,
  hasOpenedSession: boolean,
): MoneyMinor {
  if (session.featureState.freeSpinsRemaining > 0 && session.featureState.baseBetMinor) {
    return session.featureState.baseBetMinor;
  }
  if (!hasOpenedSession) return session.defaultBetMinor;
  return session.betOptionsMinor.includes(previousBetMinor) ? previousBetMinor : session.defaultBetMinor;
}
