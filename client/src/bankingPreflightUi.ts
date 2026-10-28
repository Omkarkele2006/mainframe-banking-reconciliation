export function shouldShowVsamCobolAction(state: string, canResumeLoadModule = false): boolean {
  return state === 'READY_FOR_RECONCILIATION' || (state === 'RECONCILIATION_BLOCKED' && canResumeLoadModule);
}

export function canContinueToVsamCobol(state: string, reconciliationEnabled: boolean, busy: boolean, canResumeLoadModule = false): boolean {
  return shouldShowVsamCobolAction(state, canResumeLoadModule) && reconciliationEnabled && !busy;
}
