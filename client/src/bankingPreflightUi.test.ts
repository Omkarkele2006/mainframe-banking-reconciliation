import assert from 'node:assert/strict';
import test from 'node:test';
import { canContinueToVsamCobol, shouldShowVsamCobolAction } from './bankingPreflightUi.js';

test('reports continuation action is available only for a ready persisted preflight and open server gates', () => {
  assert.equal(shouldShowVsamCobolAction('READY_FOR_RECONCILIATION'), true);
  assert.equal(canContinueToVsamCobol('READY_FOR_RECONCILIATION', true, false), true);
  assert.equal(canContinueToVsamCobol('READY_FOR_RECONCILIATION', false, false), false);
  assert.equal(canContinueToVsamCobol('READY_FOR_RECONCILIATION', true, true), false);
  for (const state of ['RECONCILIATION_PREFLIGHT', 'VSAM_COBOL_RUNNING', 'RECONCILIATION_BLOCKED', 'RECONCILIATION_UNRESOLVED', 'RECONCILIATION_COMPLETED']) {
    assert.equal(shouldShowVsamCobolAction(state), false, `${state} must not offer another submission`);
  }
  assert.equal(shouldShowVsamCobolAction('RECONCILIATION_BLOCKED', true), true);
  assert.equal(canContinueToVsamCobol('RECONCILIATION_BLOCKED', true, false, true), true);
  assert.equal(canContinueToVsamCobol('RECONCILIATION_BLOCKED', false, false, true), false);
});
