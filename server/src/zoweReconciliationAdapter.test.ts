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
