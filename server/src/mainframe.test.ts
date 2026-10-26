import assert from 'node:assert/strict';
import test from 'node:test';
import { reconciliationExecutionGate } from './mainframe.js';

const valid = {
  MAINFRAME_RECONCILIATION_ENABLED: 'true',
  MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED: 'true',
  MAINFRAME_ENABLED: 'true',
  MAINFRAME_AUTH_READY: 'true',
  MAINFRAME_ENDPOINT: 'https://zosmf.example.invalid',
  MAINFRAME_HLQ: 'Z73968',
  MAINFRAME_JOB_CLASS: '7',
  MAINFRAME_SOURCE_LIBRARY: 'Z73968.SOURCE',
  MAINFRAME_LOAD_LIBRARY: 'Z73968.LOAD',
  MAINFRAME_LOAD_MODULE: 'RECONCIL',
};

test('reconciliation is disabled by default and independent from transfer-verification flags', () => {
  const gate = reconciliationExecutionGate({ MAINFRAME_UPLOAD_TEST_REVIEWED: 'true', MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED: 'true' }, true);
  assert.equal(gate.canExecute, false);
  assert.equal(gate.enabledByAdministrator, false);
  assert.ok(gate.blockers.some((item) => item.includes('MAINFRAME_RECONCILIATION_ENABLED')));
});

test('all server gates and valid execution configuration are required', () => {
  const gate = reconciliationExecutionGate(valid, true);
  assert.equal(gate.configurationValid, true);
  assert.equal(gate.canExecute, true);
  assert.deepEqual(gate.blockers, []);
});

test('operator flags cannot bypass the repository’s unconfigured multi-stage adapter', () => {
  const gate = reconciliationExecutionGate(valid);
  assert.equal(gate.enabledByAdministrator, true);
  assert.equal(gate.canExecute, false);
  assert.ok(gate.blockers.some((item) => item.includes('adapter')));
});

test('missing TLS-risk acknowledgement and unconfigured adapter block reconciliation', () => {
  const withoutAck = { ...valid, MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED: undefined };
  const gate = reconciliationExecutionGate(withoutAck, false);
  assert.equal(gate.canExecute, false);
  assert.ok(gate.blockers.some((item) => item.includes('TLS risk')));
  assert.ok(gate.blockers.some((item) => item.includes('adapter')));
});

test('invalid endpoint, library outside configured HLQ and invalid job class fail closed', () => {
  for (const override of [
    { MAINFRAME_ENDPOINT: 'http://zosmf.example.invalid' },
    { MAINFRAME_SOURCE_LIBRARY: 'Z99999.SOURCE' },
    { MAINFRAME_JOB_CLASS: 'AB' },
    { MAINFRAME_HLQ: 'Z73968.TOO.LONG' },
  ]) {
    const gate = reconciliationExecutionGate({ ...valid, ...override }, true);
    assert.equal(gate.configurationValid, false);
    assert.equal(gate.canExecute, false);
  }
});

test('reconciliation configuration accepts only the assigned personal HLQ for project resources', () => {
  assert.equal(reconciliationExecutionGate({ ...valid, MAINFRAME_HLQ: 'Z73968' }, true).configurationValid, true);
  const publicNamespace = reconciliationExecutionGate({ ...valid, MAINFRAME_HLQ: 'ZXP', MAINFRAME_SOURCE_LIBRARY: 'ZXP.SOURCE', MAINFRAME_LOAD_LIBRARY: 'ZXP.LOAD' }, true);
  assert.equal(publicNamespace.configurationValid, false);
  assert.equal(publicNamespace.canExecute, false);
  assert.ok(publicNamespace.blockers.some((item) => item.includes('assigned Z73968 HLQ')));
});
