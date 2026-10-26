import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertDatasetUploadableState, datasetAllowedForMutation, datasetJobSubmissionBlockers, datasetMutationBlockers, decideDatasetRecovery, makeOwnedSequentialDataset, sameRecords, validateDatasetUpload, validateOwnedDatasetName, writeTransferCopy } from './datasetLifecycle.js';

const row = 'TXN0000001ACCT00000100000123420250101A';
const enabled = { MAINFRAME_HLQ: 'Z73968', MAINFRAME_DATASET_MUTATION_SCOPE: 'Z73968', MAINFRAME_DATASET_MUTATIONS_ENABLED: 'true' };

test('dataset mutation gate is independent of reconciliation and requires its server scope', () => {
  assert.deepEqual(datasetMutationBlockers(enabled), []);
  assert.ok(datasetMutationBlockers({ ...enabled, MAINFRAME_DATASET_MUTATIONS_ENABLED: 'false' }).some((item) => item.includes('MAINFRAME_DATASET_MUTATIONS_ENABLED')));
  assert.ok(datasetMutationBlockers({ ...enabled, MAINFRAME_DATASET_MUTATION_SCOPE: 'ZXP.PUBLIC' }).some((item) => item.includes('Z73968')));
  assert.ok(datasetMutationBlockers({ ...enabled, MAINFRAME_HLQ: 'ZXP.PUBLIC' }).some((item) => item.includes('Z73968')));
  assert.deepEqual(datasetMutationBlockers({ MAINFRAME_HLQ: 'Z73968', MAINFRAME_DATASET_MUTATION_SCOPE: 'Z73968', MAINFRAME_DATASET_MUTATIONS_ENABLED: 'true', MAINFRAME_ENABLED: 'false', MAINFRAME_AUTH_READY: 'false' }), []);
});

test('dataset namespace and generated run qualifier obey z/OS limits', () => {
  assert.equal(makeOwnedSequentialDataset('U1234567'), 'Z73968.U1234567.DATA');
  assert.equal(validateOwnedDatasetName('z73968.u1234567.data'), true);
  assert.equal(validateOwnedDatasetName('Z73968.BANK.TXN10K'), false);
  assert.equal(validateOwnedDatasetName('ZXP.PUBLIC.FOO'), false);
  assert.throws(() => makeOwnedSequentialDataset('U123'), /run qualifier/);
  assert.throws(() => makeOwnedSequentialDataset('Z1234567'), /run qualifier/);
  assert.equal(datasetAllowedForMutation('Z73968.U1234567.DATA', enabled), true);
  assert.equal(datasetAllowedForMutation('Z73968.BANK.TXN10K', enabled), false);
  assert.equal(datasetAllowedForMutation('ZXP.PUBLIC.DATA', enabled), false);
  assert.equal(datasetAllowedForMutation('Z73968.U1234567.DATA', { ...enabled, MAINFRAME_DATASET_MUTATION_SCOPE: 'Z73968.BANK' }), false);
});

test('fixed-width intake accepts line delimiters but preserves record data exactly', () => {
  const input = Buffer.from(`${row}\r\n${row}\n${row}`, 'ascii');
  const checked = validateDatasetUpload(input);
  assert.equal(checked.recordCount, 3);
  assert.deepEqual(checked.records, [row, row, row]);
  assert.equal(sameRecords(checked.records, [row, row, row]), true);
  assert.equal(sameRecords(checked.records, [row, row]), false);
  assert.equal(validateDatasetUpload(Buffer.from(`${row}\n`, 'ascii')).recordCount, 1);
  assert.throws(() => validateDatasetUpload(Buffer.from(`\uFEFF${row}`, 'utf8')), /expected 38/);
  assert.throws(() => validateDatasetUpload(Buffer.from(`${row}\n\n`, 'ascii')), /Record 2 has 0 bytes; expected 38/);
});

test('transfer-only copy uses normalized LF and leaves original content untouched', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledgerline-dataset-'));
  try {
    const input = Buffer.from(`${row}\r\n${row}`, 'ascii');
    const before = Buffer.from(input);
    const records = validateDatasetUpload(input).records;
    const copy = await writeTransferCopy(records, root);
    assert.equal((await fs.readFile(copy, 'ascii')), `${row}\n${row}\n`);
    assert.deepEqual(input, before);
    await fs.unlink(copy);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('NOOP smoke submission uses its independent gate and requires a valid configured class', () => {
  assert.deepEqual(datasetJobSubmissionBlockers({ MAINFRAME_JOB_SUBMISSION_ENABLED: 'true', MAINFRAME_JOB_CLASS: '7', MAINFRAME_AUTH_READY: 'false', MAINFRAME_RECONCILIATION_ENABLED: 'false' }), []);
  assert.ok(datasetJobSubmissionBlockers({ MAINFRAME_JOB_SUBMISSION_ENABLED: 'false', MAINFRAME_JOB_CLASS: '7' }).some((item) => item.includes('MAINFRAME_JOB_SUBMISSION_ENABLED')));
  assert.ok(datasetJobSubmissionBlockers({ MAINFRAME_JOB_SUBMISSION_ENABLED: 'true', MAINFRAME_JOB_CLASS: '78' }).some((item) => item.includes('MAINFRAME_JOB_CLASS')));
  assert.ok(datasetJobSubmissionBlockers({ MAINFRAME_JOB_SUBMISSION_ENABLED: 'true' }).some((item) => item.includes('MAINFRAME_JOB_CLASS')));
});

test('deleted or unresolved owned datasets reject upload while created and active datasets remain uploadable', () => {
  assert.doesNotThrow(() => assertDatasetUploadableState('CREATED'));
  assert.doesNotThrow(() => assertDatasetUploadableState('ACTIVE'));
  assert.throws(() => assertDatasetUploadableState('DELETED'), (error: unknown) => (error as {code?:string}).code === 'OWNED_DATASET_NOT_READY');
  assert.throws(() => assertDatasetUploadableState('UNCERTAIN'), (error: unknown) => (error as {code?:string}).code === 'OWNED_DATASET_NOT_READY');
});

test('recovery requires action-specific remote evidence and never infers create ownership from presence', () => {
  assert.equal(decideDatasetRecovery('CREATE',{exists:true,attributesMatch:true}).resolved,false);
  const created=decideDatasetRecovery('CREATE',{exists:true,attributesMatch:true,createCommandSucceeded:true});assert.equal(created.resolved,true);if(created.resolved)assert.equal(created.ownershipState,'CREATED');
  const uploaded=decideDatasetRecovery('UPLOAD',{exists:true,attributesMatch:true,contentMatch:true});assert.equal(uploaded.resolved,true);if(uploaded.resolved)assert.equal(uploaded.ownershipState,'ACTIVE');
  assert.equal(decideDatasetRecovery('UPLOAD',{exists:true,attributesMatch:true,contentMatch:false}).resolved,false);
  const deleted=decideDatasetRecovery('DELETE',{exists:false,attributesMatch:false});assert.equal(deleted.resolved,true);if(deleted.resolved)assert.equal(deleted.ownershipState,'DELETED');
  const stillPresent=decideDatasetRecovery('DELETE',{exists:true,attributesMatch:true},'ACTIVE');assert.equal(stillPresent.resolved,true);if(stillPresent.resolved)assert.equal(stillPresent.ownershipState,'ACTIVE');
});
