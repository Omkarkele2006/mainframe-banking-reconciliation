import type { MainframeExecutionAdapter, MainframeSubmission } from './types.js';
import { PROJECT_RECONCILIATION_HLQ } from './executionPlan.js';

// Adapter boundary for the later, approved z/OSMF/JES integration. Never emulate a run here.
export class NotConfiguredMainframeAdapter implements MainframeExecutionAdapter {
  readonly configured = false;
  async submit(): Promise<MainframeSubmission> { throw new Error('MAINFRAME_NOT_CONFIGURED'); }
}
export const mainframeAdapter: MainframeExecutionAdapter = new NotConfiguredMainframeAdapter();

export type ReconciliationExecutionGate = {
  enabledByAdministrator: boolean;
  administratorAcknowledgedTlsRisk: boolean;
  adapterConfigured: boolean;
  configurationValid: boolean;
  canExecute: boolean;
  blockers: string[];
};

function validDataset(value: string | undefined): boolean {
  return Boolean(value && value.length <= 44 && value.split('.').length >= 2
    && value.split('.').every((part) => /^[A-Z#$@][A-Z0-9#$@]{0,7}$/i.test(part)));
}

/** Reconciliation has a separate gate from the temporary transfer-verification workflow. */
export function reconciliationExecutionGate(env: NodeJS.ProcessEnv = process.env, adapterConfigured = mainframeAdapter.configured): ReconciliationExecutionGate {
  const enabledByAdministrator = env.MAINFRAME_RECONCILIATION_ENABLED === 'true';
  const administratorAcknowledgedTlsRisk = env.MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED === 'true';
  const mainframeEnabled = env.MAINFRAME_ENABLED === 'true';
  const authReady = env.MAINFRAME_AUTH_READY === 'true';
  const hlq = env.MAINFRAME_HLQ?.trim().toUpperCase();
  const endpoint = env.MAINFRAME_ENDPOINT?.trim();
  let endpointValid = false;
  try {
    const parsed = new URL(endpoint ?? '');
    endpointValid = parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { /* fail closed when no valid HTTPS endpoint is configured */ }
  const configurationValid = Boolean(hlq === PROJECT_RECONCILIATION_HLQ
    && endpointValid
    && /^[A-Z0-9]$/.test(env.MAINFRAME_JOB_CLASS?.trim().toUpperCase() ?? '')
    && validDataset(env.MAINFRAME_SOURCE_LIBRARY?.trim().toUpperCase())
    && validDataset(env.MAINFRAME_LOAD_LIBRARY?.trim().toUpperCase())
    && env.MAINFRAME_SOURCE_LIBRARY!.trim().toUpperCase().startsWith(`${hlq}.`)
    && env.MAINFRAME_LOAD_LIBRARY!.trim().toUpperCase().startsWith(`${hlq}.`)
    && /^[A-Z#$@][A-Z0-9#$@]{0,7}$/i.test(env.MAINFRAME_LOAD_MODULE?.trim() || 'RECONCIL'));
  const blockers: string[] = [];
  if (!enabledByAdministrator) blockers.push('MAINFRAME_RECONCILIATION_ENABLED is false.');
  if (!mainframeEnabled) blockers.push('MAINFRAME_ENABLED is false.');
  if (!authReady) blockers.push('MAINFRAME_AUTH_READY is false.');
  if (!administratorAcknowledgedTlsRisk) blockers.push('The administrator has not acknowledged the local Zowe profile TLS risk for reconciliation execution.');
  if (!configurationValid) blockers.push(`Execution-critical HTTPS endpoint, assigned ${PROJECT_RECONCILIATION_HLQ} HLQ, job class, source library, load library or load-module configuration is missing or invalid.`);
  if (!adapterConfigured) blockers.push('The complete reconciliation orchestration adapter is not implemented/configured.');
  return { enabledByAdministrator, administratorAcknowledgedTlsRisk, adapterConfigured, configurationValid, canExecute: blockers.length === 0, blockers };
}

export function readiness() {
  const enabled = process.env.MAINFRAME_ENABLED === 'true';
  const connectionTestConfigured = true;
  const valuesPresent = Boolean(process.env.MAINFRAME_ENDPOINT && process.env.MAINFRAME_HLQ && process.env.MAINFRAME_JOB_CLASS && process.env.MAINFRAME_SOURCE_LIBRARY && process.env.MAINFRAME_LOAD_LIBRARY);
  const adminConfigured = valuesPresent && process.env.MAINFRAME_AUTH_READY === 'true';
  const reconciliation = reconciliationExecutionGate(process.env, mainframeAdapter.configured);
  return {
    adminConfigured,
    connectionTestConfigured,
    connectionTest: 'NOT_TESTED' as const,
    authorizationReady: adminConfigured,
    reconciliationExecutionGateEnabled: reconciliation.enabledByAdministrator,
    reconciliationExecutionConfigured: reconciliation.adapterConfigured,
    reconciliationExecutionEnabled: reconciliation.canExecute,
    reconciliationBlockers: reconciliation.blockers,
    liveExecutionEnabled: enabled && adminConfigured && reconciliation.canExecute,
    mainframeExecutionConfigured: mainframeAdapter.configured,
    message: reconciliation.canExecute
      ? 'Reconciliation execution is configured, but an explicit per-run authorization is still required.'
      : `Read-only Zowe connection testing is available. Reconciliation execution is blocked: ${reconciliation.blockers.join(' ')}`,
  };
}
