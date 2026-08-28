export function checkpointInputLeaseMatchesCurrentControl(snapshot, checkpoint) {
  const lease = checkpoint?.captureBeforeInput;
  return lease !== undefined
    && snapshot?.spinAction === lease.action
    && snapshot?.spinMode === lease.mode;
}

export function renderCheckpointSignalMatches(snapshot, checkpoint) {
  if (checkpoint?.source === "stage") return snapshot?.stage === checkpoint.value;
  if (checkpoint?.source !== "milestone") return false;
  if (snapshot?.milestone === checkpoint.value) return true;
  return checkpointInputLeaseMatchesCurrentControl(snapshot, checkpoint)
    && Array.isArray(snapshot?.milestones)
    && snapshot.milestones.includes(checkpoint.value);
}

export function validateRenderCheckpointInputLeases(contracts) {
  if (!Array.isArray(contracts)) throw new Error("特殊玩法表现合同必须为数组");
  for (const contract of contracts) {
    const leaseKeys = new Set();
    if (!Array.isArray(contract?.renderCheckpoints)) {
      throw new Error("特殊玩法表现合同缺少截图 checkpoint");
    }
    for (const checkpoint of contract.renderCheckpoints) {
      const lease = checkpoint.captureBeforeInput;
      if (lease === undefined) continue;
      if (checkpoint.source !== "milestone"
        || typeof lease?.action !== "string"
        || lease.action.length === 0
        || typeof lease?.mode !== "string"
        || lease.mode.length === 0
        || checkpoint.visibleElement?.role !== "spin"
        || checkpoint.visibleElement.action !== lease.action
        || checkpoint.visibleElement.mode !== lease.mode) {
        throw new Error(`${contract.scenario} 的截图输入租约与可见控件合同不一致`);
      }
      const leaseKey = `${lease.action}:${lease.mode}`;
      if (leaseKeys.has(leaseKey)) {
        throw new Error(`${contract.scenario} 存在重复的截图输入租约：${leaseKey}`);
      }
      leaseKeys.add(leaseKey);
    }
  }
}
