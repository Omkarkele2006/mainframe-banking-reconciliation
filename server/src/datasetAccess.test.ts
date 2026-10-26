import assert from 'node:assert/strict';
import test from 'node:test';
import { datasetAllowedForRead, resolveDatasetReadScopes } from './datasetAccess.js';

test('resolves only explicit scopes within the configured HLQ',()=>{
  assert.deepEqual(resolveDatasetReadScopes({MAINFRAME_HLQ:'Z73968',MAINFRAME_DATASET_READ_SCOPES:'Z73968.BANK.*, Z73968.*'}),['Z73968.BANK.*','Z73968.*']);
  assert.deepEqual(resolveDatasetReadScopes({MAINFRAME_HLQ:'Z73968',MAINFRAME_DATASET_READ_SCOPES:'ZXP.PUBLIC.*, Z73968..*, *'}),[]);
  assert.deepEqual(resolveDatasetReadScopes({MAINFRAME_HLQ:'',MAINFRAME_DATASET_READ_SCOPES:'Z73968.*'}),[]);
});

test('allows only exact configured read masks and dataset names inside that mask',()=>{
  const config={MAINFRAME_HLQ:'Z73968',MAINFRAME_DATASET_READ_SCOPES:'Z73968.BANK.*'};
  assert.equal(datasetAllowedForRead('z73968.bank.txn10k','Z73968.BANK.*',config),true);
  assert.equal(datasetAllowedForRead('Z73968.RUN01.TXNIN','Z73968.BANK.*',config),false);
  assert.equal(datasetAllowedForRead('ZXP.PUBLIC.DATA','ZXP.PUBLIC.*',config),false);
  assert.equal(datasetAllowedForRead('Z73968.BANK.TXN10K','Z73968.*',config),false);
});
