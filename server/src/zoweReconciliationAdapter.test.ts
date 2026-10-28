import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildZoweOperationArgs } from './zoweCli.js';
import { createZoweReconciliationAdapter, zoweSpoolAdapterInternals } from './zoweReconciliationAdapter.js';

const ok = (data: unknown) => ({ exitCode: 0, stdout: JSON.stringify({ success: true, exitCode: 0, message: 'completed', stdout: '', stderr: '', data }), stderr: '' });

test('uses the installed Zowe CLI 8.36.1 JES spool command syntax', () => {
  assert.deepEqual(buildZoweOperationArgs({ kind: 'jobSpool', jobId: 'JOB12345' }), ['zos-jobs','view','all-spool-content','JOB12345','--zosmf-profile','zosmf','--rfj']);
  assert.deepEqual(buildZoweOperationArgs({ kind: 'deleteVsamCluster', dataset: 'Z73968.ABC12345.SETTLE' }), ['zos-files','delete','data-set','Z73968.ABC12345.SETTLE','--for-sure','--zosmf-profile','zosmf','--rfj']);
  assert.throws(() => buildZoweOperationArgs({ kind: 'deleteVsamCluster', dataset: 'Z73968.BANK.RECON.REF.KSDS' }), /run-owned VSAM cluster/);
});

test('load module is verified only when an exact member appears in the RFJ all-members result', async () => {
  const calls:string[][]=[];
  const adapter=createZoweReconciliationAdapter({locate:async()=>'zowe',invoke:async(_exe,args)=>{calls.push(args);return ok({success:true,apiResponse:{items:[{member:'RECONCIL',version:'1'}]}});}});
  const found=await adapter.verifyLoadModule('Z73968.LOAD','RECONCIL');
  assert.equal(found.verified,true);
  assert.deepEqual(calls[0],['zos-files','list','all-members','Z73968.LOAD','--pattern','RECONCIL','--attributes','--zosmf-profile','zosmf','--rfj']);
  const missing=createZoweReconciliationAdapter({locate:async()=>'zowe',invoke:async()=>ok({success:true,apiResponse:{items:[]}})});
  assert.equal((await missing.verifyLoadModule('Z73968.LOAD','RECONCIL')).verified,false);
  const inconclusive=createZoweReconciliationAdapter({locate:async()=>'zowe',invoke:async()=>ok({success:true,apiResponse:{items:[{member:'OTHER'}]}})});
  await assert.rejects(()=>inconclusive.verifyLoadModule('Z73968.LOAD','RECONCIL'),/exact member/);
});

test('normalizes the captured RFJ load-member envelope and fails closed on non-success or ambiguous evidence', async () => {
  const captured = { success: true, exitCode: 0, message: 'completed', stdout: '', stderr: '', data: { success: true, apiResponse: { items: [{ member: 'RECONCIL', ac: '00', amode: '31', rmode: 'ANY', size: '00004874', ttr: '00001E' }], returnedRows: 1 } } };
  const invokeResponse = (response: unknown, processExitCode = 0) => ({ exitCode: processExitCode, stdout: JSON.stringify(response), stderr: '' });
  const exact = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse(captured) });
  assert.equal((await exact.verifyLoadModule('Z73968.LOAD', 'RECONCIL')).verified, true);
  const nestedData = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse({ success: true, exitCode: 0, data: { success: true, exitCode: 0, data: captured.data } }) });
  assert.equal((await nestedData.verifyLoadModule('Z73968.LOAD', 'RECONCIL')).verified, true);

  const nestedFailure = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse({ ...captured, data: { ...captured.data, success: false } }) });
  await assert.rejects(() => nestedFailure.verifyLoadModule('Z73968.LOAD', 'RECONCIL'), /unsuccessful nested result/);
  const apiFailure = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse({ ...captured, data: { success: true, apiResponse: { success: false, items: [{ member: 'RECONCIL' }], returnedRows: 1 } } }) });
  await assert.rejects(() => apiFailure.verifyLoadModule('Z73968.LOAD', 'RECONCIL'), /API response was unsuccessful/);
  const outerFailure = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse({ ...captured, success: false }) });
  await assert.rejects(() => outerFailure.verifyLoadModule('Z73968.LOAD', 'RECONCIL'));
  const wrongMember = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse({ ...captured, data: { success: true, apiResponse: { items: [{ member: 'OTHER' }], returnedRows: 1 } } }) });
  await assert.rejects(() => wrongMember.verifyLoadModule('Z73968.LOAD', 'RECONCIL'), /exact member/);
  const malformedMember = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse({ ...captured, data: { success: true, apiResponse: { items: [{ ac: '00' }], returnedRows: 1 } } }) });
  await assert.rejects(() => malformedMember.verifyLoadModule('Z73968.LOAD', 'RECONCIL'), /exact member/);
  const missingMember = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse({ ...captured, data: { success: true, apiResponse: { items: [], returnedRows: 0 } } }) });
  assert.equal((await missingMember.verifyLoadModule('Z73968.LOAD', 'RECONCIL')).verified, false);
  const inconsistentRows = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse({ ...captured, data: { success: true, apiResponse: { items: [{ member: 'RECONCIL' }], returnedRows: 2 } } }) });
  await assert.rejects(() => inconsistentRows.verifyLoadModule('Z73968.LOAD', 'RECONCIL'), /consistent item list/);
  const nonzero = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => invokeResponse(captured, 8) });
  await assert.rejects(() => nonzero.verifyLoadModule('Z73968.LOAD', 'RECONCIL'));
  const malformed = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => ({ exitCode: 0, stdout: '{bad json', stderr: '' }) });
  await assert.rejects(() => malformed.verifyLoadModule('Z73968.LOAD', 'RECONCIL'), /malformed machine-readable output/);
  await assert.rejects(() => exact.verifyLoadModule('Z73968.OTHER', 'RECONCIL'), /Only the configured/);
});

test('validates scoped dataset-list RFJ rows and returns only supported attributes',async()=>{
  const adapter=createZoweReconciliationAdapter({locate:async()=>'zowe',invoke:async(_exe,args)=>{assert.deepEqual(args,['zos-files','list','data-set','Z73968.BANK.*','--zosmf-profile','zosmf','--attributes','--rfj']);return ok({success:true,apiResponse:{items:[{dsname:'Z73968.BANK.TXN10K',dsorg:'PS',recfm:'FB',lrecl:'38',secret:'ignored'}]}});}});
  assert.deepEqual(await adapter.listDatasets('Z73968.BANK.*'),[{dsname:'Z73968.BANK.TXN10K',dsorg:'PS',recfm:'FB',lrecl:38}]);
  const invalid=createZoweReconciliationAdapter({locate:async()=>'zowe',invoke:async()=>ok({success:true,apiResponse:{items:[{dsname:'Z73968.RUN01.TXNIN'}]}})});
  await assert.rejects(()=>invalid.listDatasets('Z73968.BANK.*'),/outside the authorized scope/);
});

test('maps a real-shaped submit result and validates JES job identity/status/condition code', async () => {
  const stagingRoot = path.resolve('..', 'server', '.uploads', `adapter-test-${crypto.randomUUID()}`);
  await fs.mkdir(stagingRoot, { recursive: true });
  const jclPath = path.join(stagingRoot, '11111111-1111-4111-8111-111111111111.jcl');
  await fs.writeFile(jclPath, '//TEST JOB CLASS=7\n');
  const responses = [ok({ jobid: 'JOB12345', jobname: 'R1A2B3C4' }), ok({ jobid: 'JOB12345', status: 'OUTPUT', retcode: 'CC 0004' }), ok([{ jobid: 'JOB12345', records: ['RECONCIL completed', 'MATCHED COUNT: 1'] }])];
  const adapter = createZoweReconciliationAdapter({ stagingRoot, locate: async () => 'zowe', invoke: async () => responses.shift()! });
  try {
    const submission = await adapter.submitJcl(jclPath);
    assert.equal(submission.jobId, 'JOB12345');
    assert.deepEqual(await adapter.jobStatus(submission.jobId), { jobId: 'JOB12345', status: 'OUTPUT', returnCode: 4, conditionCode: 'CC 0004' });
    assert.match(await adapter.jobSpool(submission.jobId), /MATCHED COUNT: 1/);
  } finally { await fs.rm(stagingRoot, { recursive: true, force: true }); }
});

test('rejects missing return codes, mismatched spool jobs and malformed spool records', async () => {
  assert.equal(zoweSpoolAdapterInternals.parseReturnCode('CC 0008'), 8);
  assert.equal(zoweSpoolAdapterInternals.parseReturnCode('ABEND S0C7'), 999);
  assert.throws(() => zoweSpoolAdapterInternals.spoolText([{ jobid: 'JOB99999', records: ['x'] }], 'JOB12345'), /does not belong/);
  assert.throws(() => zoweSpoolAdapterInternals.spoolText([{ jobid: 'JOB12345', output: 'x' }], 'JOB12345'), /readable records/);
  const adapter = createZoweReconciliationAdapter({ locate: async () => 'zowe', invoke: async () => ok({ jobid: 'JOB12345', status: 'OUTPUT' }) });
  await assert.rejects(adapter.jobStatus('JOB12345'), /parseable condition code/);
});
