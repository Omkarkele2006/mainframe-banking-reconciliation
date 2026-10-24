import type { MainframeExecutionAdapter, MainframeSubmission } from './types.js';

// Adapter boundary for the later, approved z/OSMF/JES integration. Never emulate a run here.
export class NotConfiguredMainframeAdapter implements MainframeExecutionAdapter {
  readonly configured = false;
  async submit(): Promise<MainframeSubmission> { throw new Error('MAINFRAME_NOT_CONFIGURED'); }
}
export const mainframeAdapter: MainframeExecutionAdapter = new NotConfiguredMainframeAdapter();
export function readiness() {
  const enabled = process.env.MAINFRAME_ENABLED === 'true';
  const connectionTestConfigured = true;
  const valuesPresent = Boolean(process.env.MAINFRAME_ENDPOINT && process.env.MAINFRAME_HLQ && process.env.MAINFRAME_JOB_CLASS && process.env.MAINFRAME_SOURCE_LIBRARY && process.env.MAINFRAME_LOAD_LIBRARY);
  const adminConfigured = valuesPresent && process.env.MAINFRAME_AUTH_READY === 'true';
  return { adminConfigured, connectionTestConfigured, connectionTest: 'NOT_TESTED' as const, authorizationReady: adminConfigured, liveExecutionEnabled: enabled && adminConfigured && mainframeAdapter.configured, mainframeExecutionConfigured: mainframeAdapter.configured, message: mainframeAdapter.configured ? 'Mainframe adapter configured.' : 'A local Zowe CLI profile test is available. CLI and profile availability are checked when tested; job execution is not configured.' };
}
