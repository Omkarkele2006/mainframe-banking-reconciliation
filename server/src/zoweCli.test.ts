import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { buildWindowsZoweInvocation, buildZoweOperationArgs, createSingleFlightConnectionTest, DEFAULT_ZOWE_TIMEOUT_MS, invokeZoweOperation, resolveZoweTimeoutMs, TEST_DATASET, ZOWE_PROFILE, testZoweProfile, type ProcessResult } from './zoweCli.js';
import { createZoweUploadAdapter } from './zoweUploadAdapter.js';

const status = JSON.stringify({
  success: true,
  exitCode: 0,
  message: 'Command zosmf check status completed.',
  stdout: '',
  stderr: '',
  data: {
    zosmf_hostname: 'S0W1.DAL-EBIS.IHOST.COM',
    zosmf_port: 443,
    zos_version: '02.05.00',
    plugins: [],
  },
});
const dataset = JSON.stringify({
  success: true,
  exitCode: 0,
  message: 'Command zos-files list data-set completed.',
  stdout: '',
  stderr: '',
  data: { success: true, apiResponse: { items: [{ dsname: TEST_DATASET, dsorg: 'PS', recfm: 'FB', lrecl: 38 }] } },
});
const ok = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: '' });

test('runs fixed status and dataset commands and validates machine-readable responses', async () => {
  const calls: Array<{ executable: string; args: string[]; options: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv } }> = [];
  const results = [ok(status), ok(dataset)];
  const result = await testZoweProfile({ locate: async () => 'C:\\Program Files\\Zowe\\zowe.cmd', platform: 'win32', env: { USERPROFILE: 'C:\\Users\\Operator', PATH: 'C:\\Program Files\\Zowe' }, invoke: async (executable, args, options) => { calls.push({ executable, args, options }); return results.shift()!; } });
  assert.equal(result.state, 'DATASET_ACCESS_VERIFIED');
  assert.equal(result.connectionStatus, 'VERIFIED');
  assert.equal(result.datasetAccessStatus, 'VERIFIED');
  assert.deepEqual(result.datasetAttributes, { dsorg: 'PS', recfm: 'FB', lrecl: 38 });
  assert.equal(calls[0]?.executable, 'zowe');
  assert.deepEqual(calls[0]?.args, ['zosmf', 'check', 'status', '--zosmf-profile', ZOWE_PROFILE, '--rfj']);
  assert.deepEqual(buildWindowsZoweInvocation(calls[0]!.args), {
    executable: 'cmd.exe',
    args: ['/d', '/c', 'zowe zosmf check status --zosmf-profile zosmf --rfj'],
  });
  assert.deepEqual(calls[1]?.args, ['zos-files', 'list', 'data-set', TEST_DATASET, '--zosmf-profile', ZOWE_PROFILE, '--attributes', '--rfj']);
  assert.equal(calls[1]?.args[3], TEST_DATASET);
  assert.doesNotMatch(calls[1]?.args[3] ?? '', /["']/);
  assert.deepEqual(buildWindowsZoweInvocation(calls[1]!.args), {
    executable: 'cmd.exe',
    args: ['/d', '/c', 'zowe zos-files list data-set Z73968.BANK.TXN10K --zosmf-profile zosmf --attributes --rfj'],
  });
  assert.equal(buildWindowsZoweInvocation(calls[1]!.args).args[2]?.includes('data-set "'), false);
  assert.throws(() => buildWindowsZoweInvocation(['zos-files', 'list', 'data-set', 'UNTRUSTED.DATASET', '--rfj']), /Unsupported Zowe CLI invocation/);
  assert.equal(calls[0]?.options.cwd, os.homedir());
  assert.equal(calls[0]?.options.maxOutputBytes, 1024 * 1024);
  assert.equal(calls[0]?.options.timeoutMs, DEFAULT_ZOWE_TIMEOUT_MS);
  assert.equal(calls[1]?.options.timeoutMs, DEFAULT_ZOWE_TIMEOUT_MS);
  assert.equal(calls[0]?.options.env.PATH, 'C:\\Program Files\\Zowe');
  assert.equal(calls[0]?.options.env.USERPROFILE, 'C:\\Users\\Operator');
});

test('uses a validated configured command timeout and defaults to 45 seconds', async () => {
  assert.equal(resolveZoweTimeoutMs({}), 45_000);
  assert.equal(resolveZoweTimeoutMs({ ZOWE_CLI_TIMEOUT_MS: '30000' }), 30_000);
  assert.throws(() => resolveZoweTimeoutMs({ ZOWE_CLI_TIMEOUT_MS: '150' }), /between 1000 and 60000/);
  const responses = [ok(status), ok(dataset)];
  let commandCount = 0;
  const result = await testZoweProfile({ env: { ZOWE_CLI_TIMEOUT_MS: '30000' }, locate: async () => 'zowe', invoke: async (_executable, _args, options) => { assert.equal(options.timeoutMs, 30_000); commandCount += 1; return responses.shift()!; } });
  assert.equal(result.state, 'DATASET_ACCESS_VERIFIED');
  assert.equal(commandCount, 2);
});

test('coalesces duplicate connection requests and releases the flight after timeout', async () => {
  let calls = 0;
  let rejectCurrent: ((error: Error) => void) | undefined;
  const run = createSingleFlightConnectionTest(() => {
    calls += 1;
    return new Promise((_resolve, reject) => { rejectCurrent = reject; });
  });
  const first = run();
  const second = run();
  assert.equal(first, second);
  assert.equal(calls, 1);
  rejectCurrent!(Object.assign(new Error('timed out'), { code: 'ZOWE_TIMEOUT' }));
  await assert.rejects(first, /timed out/);
  const retry = run();
  assert.equal(calls, 2);
  rejectCurrent!(Object.assign(new Error('timed out'), { code: 'ZOWE_TIMEOUT' }));
  await assert.rejects(retry, /timed out/);
});

test('returns actionable missing CLI status without invoking a process', async () => {
  let invoked = false;
  const result = await testZoweProfile({ locate: async () => undefined, invoke: async () => { invoked = true; return ok(status); } });
  assert.equal(result.state, 'CLI_UNAVAILABLE');
  assert.equal(result.errorCategory, 'CLI_UNAVAILABLE');
  assert.match(result.message, /Install it|PATH/);
  assert.equal(invoked, false);
});

test('classifies authentication failure from the actual CLI response and does not expose raw output', async () => {
  const result = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ({ exitCode: 1, stdout: JSON.stringify({ success: false, exitCode: 8, message: 'Authentication failed for user Z73968 password=secret-value', stdout: '', stderr: '', data: null }), stderr: '' }) });
  assert.equal(result.state, 'CONNECTION_FAILED');
  assert.equal(result.errorCategory, 'AUTHENTICATION');
  assert.match(result.message, /local zosmf profile/);
  assert.doesNotMatch(JSON.stringify(result), /secret-value|Z73968/);
});

test('classifies TLS and denied dataset access while preserving the successful connection status', async () => {
  const calls = [ok(status), { exitCode: 1, stdout: JSON.stringify({ success: false, exitCode: 1, message: '403 Forbidden: dataset access denied', stdout: '', stderr: '', data: null }), stderr: '' }];
  const result = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => calls.shift()! });
  assert.equal(result.state, 'DATASET_ACCESS_FAILED');
  assert.equal(result.connectionStatus, 'VERIFIED');
  assert.equal(result.datasetAccessStatus, 'DENIED');
  assert.equal(result.errorCategory, 'DATASET_ACCESS');
  assert.match(result.message, new RegExp(TEST_DATASET));
  assert.equal(result.executionEnabled, false);

  const tls = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ({ exitCode: 1, stdout: '', stderr: 'unable to verify certificate' }) });
  assert.equal(tls.errorCategory, 'TLS');
  assert.match(tls.message, /local Zowe profile and endpoint/i);
  assert.doesNotMatch(tls.message, /verification remains enabled|certificate validation succeeded/i);
});

test('reports timeout and malformed JSON safely', async () => {
  const timeout = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => { throw Object.assign(new Error('timeout password=secret'), { code: 'ZOWE_TIMEOUT' }); } });
  assert.equal(timeout.errorCategory, 'TIMEOUT');
  assert.match(timeout.message, /timed out/i);
  assert.doesNotMatch(JSON.stringify(timeout), /secret/);

  const malformed = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ok('not json') });
  assert.equal(malformed.errorCategory, 'OUTPUT_MALFORMED');
  assert.equal(malformed.state, 'CONNECTION_FAILED');
});

test('fails closed for unsuccessful RFJ envelopes and subprocess exit failures', async () => {
  const unsuccessful = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ({ exitCode: 8, stdout: JSON.stringify({ success: false, exitCode: 8, message: 'Profile check failed.', stdout: '', stderr: '', data: null }), stderr: '' }) });
  assert.equal(unsuccessful.state, 'CONNECTION_FAILED');
  assert.equal(unsuccessful.errorCategory, 'CLI_ERROR');

  const processFailure = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ({ exitCode: 5, stdout: status, stderr: 'process failed' }) });
  assert.equal(processFailure.state, 'CONNECTION_FAILED');
  assert.equal(processFailure.errorCategory, 'CLI_ERROR');

  const rfjExitFailure = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ({ exitCode: 0, stdout: JSON.stringify({ success: true, exitCode: 5, message: 'Profile status failed.', stdout: '', stderr: '', data: status }), stderr: '' }) });
  assert.equal(rfjExitFailure.state, 'CONNECTION_FAILED');
  assert.equal(rfjExitFailure.errorCategory, 'CLI_ERROR');
});

test('rejects a successful connection envelope with missing z/OSMF data fields', async () => {
  const malformedData = JSON.stringify({ success: true, exitCode: 0, message: 'Completed.', stdout: '', stderr: '', data: { zosmf_hostname: 'host', zosmf_port: 443 } });
  const result = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ok(malformedData) });
  assert.equal(result.state, 'CONNECTION_FAILED');
  assert.equal(result.errorCategory, 'OUTPUT_MALFORMED');
  assert.match(result.message, /unexpected machine-readable output/i);
});

test('distinguishes network failures from malformed output', async () => {
  const network = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ({ exitCode: 1, stdout: JSON.stringify({ success: false, exitCode: 1, message: 'getaddrinfo ENOTFOUND zosmf.example.invalid', stdout: '', stderr: '', data: null }), stderr: '' }) });
  assert.equal(network.errorCategory, 'NETWORK');
  assert.match(network.message, /network access|DNS/i);
  assert.doesNotMatch(JSON.stringify(network), /example\.invalid/);
});

test('classifies local Zowe initialization and file-permission failures without exposing details', async () => {
  const result = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => ({ exitCode: 1, stdout: '', stderr: "Error initializing Zowe CLI: EPERM operation not permitted, open 'C:\\Users\\Operator\\.zowe\\logs\\imperative.log'" }) });
  assert.equal(result.errorCategory, 'CLI_ERROR');
  assert.match(result.message, /local CLI\/profile permissions/i);
  assert.doesNotMatch(JSON.stringify(result), /imperative\.log|Operator/);
});

test('fails closed when the dataset command returns malformed or unrelated output', async () => {
  const calls = [ok(status), ok(JSON.stringify({ success: true, exitCode: 0, message: 'Completed.', stdout: '', stderr: '', data: { success: true, apiResponse: { items: [{ dsname: 'OTHER.DATASET', dsorg: 'PS' }] } } }))];
  const result = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => calls.shift()! });
  assert.equal(result.connectionStatus, 'VERIFIED');
  assert.equal(result.datasetAccessStatus, 'FAILED');
  assert.equal(result.errorCategory, 'OUTPUT_MALFORMED');
  assert.equal(result.state, 'DATASET_ACCESS_FAILED');
});

test('does not infer dataset access from a successful connection when its RFJ result fails', async () => {
  const calls = [ok(status), { exitCode: 4, stdout: JSON.stringify({ success: false, exitCode: 4, message: 'Data set not found.', stdout: '', stderr: '', data: { success: false, apiResponse: { items: [] } } }), stderr: '' }];
  const result = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => calls.shift()! });
  assert.equal(result.connectionStatus, 'VERIFIED');
  assert.equal(result.datasetAccessStatus, 'FAILED');
  assert.equal(result.state, 'DATASET_ACCESS_FAILED');
});

test('requires nested RFJ success and apiResponse.items for dataset access', async () => {
  const envelopes = [
    { success: true, apiResponse: { items: [{ dsname: TEST_DATASET }] } },
    { success: false, apiResponse: { items: [{ dsname: TEST_DATASET }] } },
    { success: true, apiResponse: { items: [] } },
  ];
  for (const [index, data] of envelopes.entries()) {
    const calls = [ok(status), ok(JSON.stringify({ success: true, exitCode: 0, message: 'Completed.', stdout: '', stderr: '', data }))];
    const result = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => calls.shift()! });
    assert.equal(result.connectionStatus, 'VERIFIED');
    assert.equal(result.datasetAccessStatus, index === 0 ? 'VERIFIED' : 'FAILED');
    assert.equal(result.state, index === 0 ? 'DATASET_ACCESS_VERIFIED' : 'DATASET_ACCESS_FAILED');
  }
});

test('accepts the verified dataset RFJ structure only with a zero subprocess exit status', async () => {
  const response = JSON.stringify({ success: true, exitCode: 0, message: 'Completed.', stdout: '', stderr: '', data: { success: true, apiResponse: { items: [{ dsname: TEST_DATASET, dsorg: 'PS', recfm: 'FB', lrecl: 38 }] } } });
  const calls = [ok(status), { exitCode: 1, stdout: response, stderr: '' }];
  const result = await testZoweProfile({ locate: async () => 'zowe', invoke: async () => calls.shift()! });
  assert.equal(result.connectionStatus, 'VERIFIED');
  assert.equal(result.datasetAccessStatus, 'FAILED');
});

test('constructs only fixed Zowe operations and safely quotes staged paths containing spaces on Windows', () => {
  const upload = buildZoweOperationArgs({kind:'uploadSequential',dataset:'Z73968.ABC12345.TXNIN',localPath:'C:\\IMP\\VIT\\SEM I\\server\\.uploads\\12345678-1234-1234-1234-123456789abc.txt'});
  assert.deepEqual(upload,['zos-files','upload','file-to-data-set','C:\\IMP\\VIT\\SEM I\\server\\.uploads\\12345678-1234-1234-1234-123456789abc.txt','Z73968.ABC12345.TXNIN','--encoding','IBM-1047','--zosmf-profile','zosmf','--rfj']);
  const invocation=buildWindowsZoweInvocation(upload);
  assert.equal(invocation.args[0],'/d');assert.equal(invocation.args[1],'/c');
  assert.match(invocation.args[2]??'',/"C:\\IMP\\VIT\\SEM I\\server\\.uploads\\12345678-1234-1234-1234-123456789abc\.txt"/);
  assert.doesNotMatch(invocation.args[2]??'',/\/s/);
  assert.throws(()=>buildZoweOperationArgs({kind:'deleteDataset',dataset:'Z73968.BANK.TXN10K;DEL'}),/Invalid data set/);
  assert.throws(()=>buildZoweOperationArgs({kind:'submitJcl',localPath:'C:\\temp\\x.jcl & whoami'}),/Invalid staged JCL/);
  assert.throws(()=>buildWindowsZoweInvocation(['zos-jobs','submit','bad-command','--rfj']),/Unsupported Zowe CLI invocation/);
});

test('constructs the fixed PS/FB/38 allocation command and text-mode transfer operations', () => {
  const create = buildZoweOperationArgs({ kind:'createSequential', dataset:'Z73968.UABC1234.TXNIN', primaryTracks:4, secondaryTracks:1 });
  assert.deepEqual(create,['zos-files','create','data-set-sequential','Z73968.UABC1234.TXNIN','--size','4TRK','--secondary-space','1','--record-format','FB','--record-length','38','--block-size','27968','--attributes','--zosmf-profile','zosmf','--rfj']);
  const rendered = buildWindowsZoweInvocation(create);
  assert.deepEqual(rendered.args,['/d','/c','zowe zos-files create data-set-sequential Z73968.UABC1234.TXNIN --size 4TRK --secondary-space 1 --record-format FB --record-length 38 --block-size 27968 --attributes --zosmf-profile zosmf --rfj']);
  const upload = buildZoweOperationArgs({kind:'uploadSequential',dataset:'Z73968.UABC1234.TXNIN',localPath:'C:\\Users\\Operator Name\\staging\\11111111-1111-4111-8111-111111111111.txt'});
  assert.equal(upload.includes('--binary'),false);
  assert.deepEqual(upload.slice(upload.indexOf('--encoding')), ['--encoding','IBM-1047','--zosmf-profile','zosmf','--rfj']);
  assert.match(buildWindowsZoweInvocation(upload).args[2]??'',/"C:\\Users\\Operator Name\\staging\\11111111-1111-4111-8111-111111111111\.txt"/);
  const download = buildZoweOperationArgs({kind:'downloadDataset',dataset:'Z73968.UABC1234.TXNIN',localPath:'C:\\Users\\Operator Name\\staging\\22222222-2222-4222-8222-222222222222.out'});
  assert.equal(download.includes('--binary'),false);
  assert.throws(()=>buildZoweOperationArgs({kind:'createSequential',dataset:'Z73968.BANK.TXN10K',primaryTracks:0,secondaryTracks:1}),/allocation parameters/);
  assert.throws(()=>buildWindowsZoweInvocation([...create,'--user','untrusted']),/Unsupported Zowe CLI invocation/);
});

test('operation execution requires a successful RFJ envelope and the requested dataset resource', async () => {
  const response=JSON.stringify({success:true,exitCode:0,message:'Completed.',stdout:'',stderr:'',data:{success:true,apiResponse:{items:[{dsname:'Z73968.ABC12345.TXNIN',dsorg:'PS',recfm:'FB',lrecl:38}]}}});
  const result=await invokeZoweOperation({kind:'datasetAttributes',dataset:'Z73968.ABC12345.TXNIN'},{platform:'win32',env:{PATH:'C:\\zowe'},locate:async()=>'C:\\zowe\\zowe.cmd',invoke:async(_exe,args)=>{assert.equal(args[3],'Z73968.ABC12345.TXNIN');return ok(response);}});
  assert.equal((result.data as {success:boolean}).success,true);
  await assert.rejects(()=>invokeZoweOperation({kind:'datasetAttributes',dataset:'Z73968.ABC12345.TXNIN'},{platform:'win32',env:{PATH:'C:\\zowe'},locate:async()=>'zowe.cmd',invoke:async()=>ok(JSON.stringify({success:true,exitCode:0,data:{success:false,apiResponse:{items:[]}}}))}),(error:unknown)=>(error as {code?:string}).code==='RFJ_RESOURCE_INVALID');
  await assert.rejects(()=>invokeZoweOperation({kind:'datasetAttributes',dataset:'Z73968.ABC12345.TXNIN'},{platform:'win32',env:{},locate:async()=>undefined}),/unavailable/);
});

test('treats an empty successful exact-name query as absence, without quoting the remote dataset', async () => {
  const response = JSON.stringify({ success: true, exitCode: 0, message: 'Completed.', stdout: '', stderr: '', data: { success: true, apiResponse: { items: [] } } });
  let argsSeen: string[] = [];
  const adapter = createZoweUploadAdapter({ platform: 'win32', env: { PATH: 'C:\\zowe' }, locate: async () => 'zowe.cmd', invoke: async (_executable, args) => { argsSeen = args; return ok(response); } });
  await assert.rejects(() => adapter.attributes('z73968.uabc1234.txnin'), (error: unknown) => (error as { code?: string }).code === 'DATASET_NOT_FOUND');
  assert.equal(argsSeen[3], 'Z73968.UABC1234.TXNIN');
  assert.doesNotMatch(argsSeen[3] ?? '', /["']/);
  assert.deepEqual(buildWindowsZoweInvocation(argsSeen).args.slice(0, 2), ['/d', '/c']);
});

test('matches returned dataset names case-insensitively after normalizing the validated name', async () => {
  const response = JSON.stringify({ success: true, exitCode: 0, message: 'Completed.', stdout: '', stderr: '', data: { success: true, apiResponse: { items: [{ dsname: 'z73968.uabc1234.txnin', dsorg: 'PS', recfm: 'FB', lrecl: 38 }] } } });
  const adapter = createZoweUploadAdapter({ platform: 'win32', env: { PATH: 'C:\\zowe' }, locate: async () => 'zowe.cmd', invoke: async () => ok(response) });
  assert.deepEqual(await adapter.attributes('Z73968.UABC1234.TXNIN'), { dsname: 'z73968.uabc1234.txnin', dsorg: 'PS', recfm: 'FB', lrecl: 38 });
});

test('fails closed on unexpected rows, malformed RFJ data, unsuccessful nested API results, CLI failures and timeouts', async () => {
  const expected = 'Z73968.UABC1234.TXNIN';
  const invokeWith = (stdout: string, exitCode = 0) => invokeZoweOperation({ kind: 'datasetAttributes', dataset: expected }, { platform: 'win32', env: { PATH: 'C:\\zowe' }, locate: async () => 'zowe.cmd', invoke: async () => ({ exitCode, stdout, stderr: '' }) });
  const envelope = (data: unknown) => JSON.stringify({ success: true, exitCode: 0, message: 'Completed.', stdout: '', stderr: '', data });
  await assert.rejects(() => invokeWith(envelope({ success: true, apiResponse: { items: [{ dsname: 'Z73968.OTHER.TXNIN' }] } })), (error: unknown) => (error as { code?: string }).code === 'RFJ_RESOURCE_INVALID');
  await assert.rejects(() => invokeWith('{malformed'), (error: unknown) => (error as { code?: string }).code === 'RFJ_JSON_INVALID');
  await assert.rejects(() => invokeWith(envelope({ success: false, message: '403 Forbidden', apiResponse: { items: [] } })), (error: unknown) => (error as { code?: string }).code === 'AUTHORIZATION');
  const failedCli = JSON.stringify({ success: false, exitCode: 8, message: '403 Forbidden', stdout: '', stderr: '', data: { success: false, apiResponse: { items: [] } } });
  await assert.rejects(() => invokeWith(failedCli, 8), (error: unknown) => (error as { code?: string }).code === 'AUTHORIZATION');
  await assert.rejects(() => invokeZoweOperation({ kind: 'datasetAttributes', dataset: expected }, { platform: 'win32', env: { PATH: 'C:\\zowe' }, locate: async () => 'zowe.cmd', invoke: async () => { throw Object.assign(new Error('timed out'), { code: 'ZOWE_TIMEOUT' }); } }), (error: unknown) => (error as { code?: string }).code === 'TIMEOUT');
});

test('classifies a nonzero RFJ dataset-not-found response so collision checks fail closed without treating it as access success', async () => {
  const missing = JSON.stringify({ success:false, exitCode:8, message:'Data set Z73968.UABC1234.TXNIN not found.', stdout:'', stderr:'', data:{success:false,apiResponse:{items:[]}} });
  await assert.rejects(()=>invokeZoweOperation({kind:'datasetAttributes',dataset:'Z73968.UABC1234.TXNIN'},{platform:'win32',env:{PATH:'C:\\zowe'},locate:async()=> 'zowe.cmd',invoke:async()=>({exitCode:8,stdout:missing,stderr:''})}),(error:unknown)=>{assert.equal((error as {code?:string}).code,'DATASET_NOT_FOUND');assert.doesNotMatch((error as Error).message,/Z73968/);return true;});
});

test('validates JES job identity and requires spool evidence rather than success-shaped empty results', async () => {
  await assert.rejects(()=>invokeZoweOperation({kind:'jobStatus',jobId:'JOB12345'},{platform:'win32',env:{},locate:async()=>'zowe',invoke:async()=>ok(JSON.stringify({success:true,exitCode:0,data:{jobid:'JOB00000',status:'OUTPUT',retcode:'CC 0000'}}))}),/did not match/);
  await assert.rejects(()=>invokeZoweOperation({kind:'jobSpool',jobId:'JOB12345'},{platform:'win32',env:{},locate:async()=>'zowe',invoke:async()=>ok(JSON.stringify({success:true,exitCode:0,data:[]}))}),/no output records/);
  await assert.rejects(()=>invokeZoweOperation({kind:'jobStatus',jobId:'JOB12345'},{platform:'win32',env:{},locate:async()=>'zowe',invoke:async()=>{throw Object.assign(new Error('password=secret'),{code:'ZOWE_TIMEOUT'});}}),(error:unknown)=>{assert.match((error as Error).message,/TIMEOUT/);assert.doesNotMatch((error as Error).message,/secret/);return true;});
});
