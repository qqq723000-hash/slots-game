export interface ControlGateState {
  launchReady: boolean;
  gameReady: boolean;
  online: boolean;
  pendingSpin: boolean;
}

export function canEnableSpin(state: ControlGateState): boolean {
  return state.launchReady && state.gameReady && state.online && !state.pendingSpin;
}
