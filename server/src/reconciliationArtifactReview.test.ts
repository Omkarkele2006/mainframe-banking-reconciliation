import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mainframeAdapter, reconciliationExecutionGate } from './mainframe.js';

const serverSource = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(serverSource, '../..');
const read = (path: string) => readFile(resolve(repositoryRoot, path), 'utf8');

test('static artifact review detects the current shared smoke dataset assumptions', async () => {
  const [rexx, master, eod, vsamLoad] = await Promise.all([
    read('rexx/VALIDATE.rex'),
    read('jcl/master/MASTER.jcl'),
    read('jcl/eod/EOD_VALIDATION.jcl'),
    read('vsam/VSAM_LOAD.jcl'),
  ]);

  assert.match(rexx, /TRAN_DSN\s*=\s*'Z73968\.BANK\.TXNSORT'/);
  assert.match(rexx, /SETT_DSN\s*=\s*'Z73968\.BANK\.SETSORT'/);
  assert.match(master, /DSN=Z73968\.BANK\.TXNTEST/);
  assert.match(master, /DSN=Z73968\.BANK\.SETTEST/);
  assert.match(master, /NOTEQUAL\(5\)/);
  assert.match(eod, /NOTEQUAL\(5\)/);
  assert.match(vsamLoad, /REPRO INFILE\(INPUT\)\s*-\s*REPLACE\s*-\s*OUTDATASET\(Z73968\.BANK\.RECON\.REF\.KSDS\)/);
});

test('reconciliation API source remains fail-closed while the adapter is not configured', async () => {
  const api = await read('server/src/index.ts');
  assert.equal(mainframeAdapter.configured, false);
  await assert.rejects(mainframeAdapter.submit({ runId: 'audit-only', transactionPath: '', settlementPath: '', profile: 'SMOKE' }), /MAINFRAME_NOT_CONFIGURED/);
  assert.match(api, /status:'NOT_CONFIGURED'/);
  assert.match(api, /MAINFRAME_RECONCILIATION_NOT_CONFIGURED/);
  assert.doesNotMatch(api, /mainframeAdapter\.submit\s*\(/);
});

test('reconciliation execution gate remains blocked with the repository adapter even if flags are acknowledged', () => {
  const gate = reconciliationExecutionGate({
    MAINFRAME_RECONCILIATION_ENABLED: 'true',
    MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED: 'true',
    MAINFRAME_ENABLED: 'true',
    MAINFRAME_AUTH_READY: 'true',
    MAINFRAME_ENDPOINT: 'https://zosmf.example.invalid',
    MAINFRAME_HLQ: 'Z73968',
    MAINFRAME_JOB_CLASS: '7',
    MAINFRAME_SOURCE_LIBRARY: 'Z73968.SOURCE',
    MAINFRAME_LOAD_LIBRARY: 'Z73968.LOAD',
  });
  assert.equal(gate.canExecute, false);
  assert.equal(gate.adapterConfigured, false);
  assert.ok(gate.blockers.some((blocker) => blocker.includes('adapter')));
});
