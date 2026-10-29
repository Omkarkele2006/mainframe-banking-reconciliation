import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRunExecutionPlan,
  buildExecutionPlanPreview,
  assertSuccessfulJesJob,
  countConsistencyError,
  createDatasetToken,
  createRunId,
  eodPublicationAllowed,
  generateAllocationJcl,
  generateEodJcl,
  generatePreflightJcl,
  generateReconciliationJcl,
  parseCobolCounts,
  aggregateMatchedAmountCents,
  countDownloadedRecords,
  MAX_UPLOAD_BYTES,
  TRACK_BYTES_3390,
  type CobolCounts,
} from './executionPlan.js';
import { validateFixedWidthFile } from './validation.js';

const config = { hlq: 'Z73968', jobClass: '7', sourceLibrary: 'Z73968.SOURCE', loadLibrary: 'Z73968.LOAD', loadModule: 'RECONCIL', rexxMember: 'VALIDATE' };
const counts: CobolCounts = { transactionCount: 5, settlementCount: 5, matchedCount: 5, mismatchedCount: 0, transactionOnlyCount: 0, settlementOnlyCount: 0 };
const spool = [
  'TRANSACTION INPUT COUNT: 0000005',
  'SETTLEMENT INPUT COUNT:  0000005',
  'MATCHED COUNT:           0000005',
  'MISMATCHED COUNT:        0000000',
  'TRANSACTION-ONLY COUNT:  0000000',
  'SETTLEMENT-ONLY COUNT:   0000000',
].join('\n');

function plan(token: string) {
  const files = { transaction: { originalName: 'txn.txt', size: 200, recordCount: 5, valid: true }, settlement: { originalName: 'set.txt', size: 200, recordCount: 5, valid: true } };
  return buildRunExecutionPlan('REC-20261023-0123456789ABCDEF0123', config, token, files);
}

function preview(transactionCount: number, settlementCount: number, token = 'R1A2B3C4') {
  return buildExecutionPlanPreview({
    runId: 'REC-20261023-0123456789ABCDEF0123', organization: { id: 'org-1', name: 'Example Bank' }, profile: transactionCount === 10_000 ? 'VOLUME_10K' : 'SMOKE',
    transaction: { originalName: 'transactions.txt', size: transactionCount * 40, recordCount: transactionCount, valid: true },
    settlement: { originalName: 'settlements.txt', size: settlementCount * 40, recordCount: settlementCount, valid: true }, config, token,
  });
}

test('creates collision-resistant run identifiers and unique valid dataset qualifiers', () => {
  const first = createRunId(new Date('2026-10-23T00:00:00Z'));
  const second = createRunId(new Date('2026-10-23T00:00:00Z'));
  assert.match(first, /^REC-20261023-[A-F0-9]{20}$/);
  assert.notEqual(first, second);
  const a = plan(createDatasetToken());
  const b = plan(createDatasetToken());
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.datasets.TXNIN, b.datasets.TXNIN);
  for (const dsn of Object.values(a.datasets)) {
    assert.ok(dsn.startsWith('Z73968.'), `project dataset must stay under the assigned HLQ: ${dsn}`);
    assert.ok(!dsn.startsWith('ZXP.PUBLIC.'), `public namespace is prohibited: ${dsn}`);
    assert.ok(dsn.length <= 44);
    assert.ok(dsn.split('.').every((qualifier) => qualifier.length <= 8));
  }
  assert.equal(a.collisionCheckRequired, true);
  assert.equal(a.cleanupPolicy, 'RETAIN_PENDING_APPROVAL');
  assert.throws(() => buildRunExecutionPlan(a.runId, config, 'BAD-TOKEN', { transaction: { originalName: 'x', size: 200, recordCount: 5, valid: true }, settlement: { originalName: 'y', size: 200, recordCount: 5, valid: true } }), /token is invalid/);
  assert.throws(() => buildRunExecutionPlan(a.runId, { ...config, hlq: 'BASELINE.TXNTEST' }, a.token, { transaction: { originalName: 'x', size: 200, recordCount: 5, valid: true }, settlement: { originalName: 'y', size: 200, recordCount: 5, valid: true } }), /HLQ must be one approved/);
});

test('validates fixed-width files without treating blank files as valid or rewriting bytes', () => {
  const record = Buffer.from('TXN0000001ACCT00000100005000020261023A', 'ascii');
  const valid = validateFixedWidthFile(Buffer.concat([record, Buffer.from('\r\n')]));
  assert.equal(valid.valid, true);
  assert.equal(valid.recordCount, 1);
  assert.equal(valid.preview[0], record.toString('ascii'));
  assert.equal(validateFixedWidthFile(Buffer.alloc(0)).valid, false);
  assert.match(validateFixedWidthFile(Buffer.from('short\n')).errors[0] ?? '', /expected 38/);
});

test('generates fixed, run-scoped allocation and preflight JCL without baseline or destructive targets', () => {
  const current = plan('R1A2B3C4');
  const allocation = generateAllocationJcl(current);
  const preflight = generatePreflightJcl(current);
  assert.ok(`${allocation}\n${preflight}`.split('\n').every((line) => line.length <= 71), 'JCL cards must fit the standard 71-column statement area.');
  assert.match(allocation, new RegExp(`DSN=${current.datasets.TXNIN}`));
  assert.match(allocation, new RegExp(`DSN=${current.datasets.SETIN}`));
  assert.match(allocation, /DISP=\(NEW,CATLG,KEEP\)/);
  assert.doesNotMatch(allocation + preflight, /DISP=DELETE|Z73968\.BANK\.(?:TXNTEST|SETTEST|TXN10K|SET10K|FINAL10K|RECON\.REF\.KSDS)/i);
  assert.match(preflight, /SUM FIELDS=NONE/);
  assert.match(preflight, /SELECT FROM\(SETIN\) TO\(DUPES\) ON\(1,10,CH\) ALLDUPS/);
  assert.match(preflight, /COUNT FROM\(DUPIN\) NOTEQUAL\(0\) RC8/);
  assert.match(preflight, /IFTXN\s+IF \(TXNSORT\.RC = 0\) THEN[\s\S]*SETSORT\s+EXEC/);
  assert.match(preflight, /IFSET\s+IF \(SETSORT\.RC = 0\) THEN[\s\S]*DUPSEL\s+EXEC/);
  assert.match(preflight, /IFDUP\s+IF \(DUPSEL\.RC = 0\) THEN[\s\S]*DUPCNT\s+EXEC/);
  assert.match(preflight, /ENDIFDP\s+ENDIF[\s\S]*ENDIFST\s+ENDIF[\s\S]*ENDIFTX\s+ENDIF/);
  assert.equal(current.duplicatePolicy.transaction, 'DEDUPLICATE_BY_ID_KEEP_FIRST_AS_EXISTING_MASTER');
  assert.equal(current.duplicatePolicy.settlement, 'FAIL_ON_DUPLICATE_KEY_BEFORE_VSAM_LOAD');
});

test('generates run-specific VSAM and COBOL DD mappings using the deployed contract', () => {
  const current = plan('R1A2B3C4');
  const jcl = generateReconciliationJcl(current);
  assert.ok(jcl.split('\n').every((line) => line.length <= 71), 'JCL cards must fit the standard 71-column statement area.');
  for (const dd of ['TRANIN', 'SETTIN', 'MATCHOUT', 'MISMOUT', 'TXNMISS', 'SETMISS']) assert.match(jcl, new RegExp(`//${dd}\\s+DD`));
  assert.match(jcl, new RegExp(`NAME\\(${current.datasets.SETTLE}\\)`));
  assert.match(jcl, new RegExp(`DSN=${current.config.loadLibrary},DISP=SHR`));
  assert.match(jcl, new RegExp(`PGM=${current.config.loadModule}`));
  assert.match(jcl, /IFCRT\s+IF \(VSAMCRT\.RC = 0\) THEN[\s\S]*VSAMLOAD\s+EXEC/);
  assert.match(jcl, /IFLOAD\s+IF \(VSAMLOAD\.RC = 0\) THEN[\s\S]*RECONCIL\s+EXEC/);
  assert.match(jcl, /ENDIFLD\s+ENDIF[\s\S]*ENDIFCR\s+ENDIF/);
  assert.match(jcl, /TRACKS\(\d+ \d+\)/);
  assert.match(jcl, /TRANIN\s+DD DSN=.*TXNSORT.*DISP=SHR/);
  assert.match(jcl, /SETTIN\s+DD DSN=.*SETTLE.*DISP=SHR/);
  assert.match(jcl, /MATCHOUT\s+DD[\s\S]*DCB=\(DSORG=PS,RECFM=FB,LRECL=38/);
  for (const dd of ['MISMOUT','TXNMISS','SETMISS']) assert.match(jcl, new RegExp(`${dd}\\s+DD[\\s\\S]*LRECL=120`));
  assert.doesNotMatch(jcl, /Z73968\.BANK\./);
  assert.doesNotMatch(jcl, /DELETE/);
});

test('keeps IDCAMS VSAM creation and load controls inside their SYSIN data blocks', () => {
  const current = plan('R1A2B3C4');
  const jcl = generateReconciliationJcl(current);
  const blocks = [...jcl.matchAll(/\/\/SYSIN\s+DD \*\n([\s\S]*?)\n\/\*\n(?=\/\/)/g)].map((match) => match[1]!);

  assert.equal(blocks.length, 2, 'both IDCAMS steps must have terminated in-stream SYSIN data');
  assert.match(blocks[0]!, /DEFINE CLUSTER \( -[\s\S]*NAME\(Z73968\.R1A2B3C4\.SETTLE\)[\s\S]*INDEXED KEYS\(10 0\) RECORDSIZE\(38 38\) TRACKS\(\d+ \d+\)[\s\S]*DATA \(NAME\(Z73968\.R1A2B3C4\.SETDATA\)\)[\s\S]*INDEX \(NAME\(Z73968\.R1A2B3C4\.SETIDX\)\)/);
  const expectedDefine = [
    '  DEFINE CLUSTER ( -',
    `    NAME(${current.datasets.SETTLE}) -`,
    `    INDEXED KEYS(10 0) RECORDSIZE(38 38) TRACKS(${current.allocation.settlementVsamPrimaryTracks} ${current.allocation.settlementVsamSecondaryTracks})) -`,
    `    DATA (NAME(${current.datasets.SETTLE_DATA})) -`,
    `    INDEX (NAME(${current.datasets.SETTLE_INDEX}))`,
  ].join('\n');
  assert.equal(blocks[0], expectedDefine);
  let depth=0;
  for(const character of blocks[0]!){if(character==='(')depth++;if(character===')')depth--;assert.ok(depth>=0);}
  assert.equal(depth,0);
  assert.ok(jcl.includes(`${expectedDefine}\n/*\n//IFCRT`));
  assert.match(blocks[1]!, /REPRO INFILE\(INPUT\) OUTDATASET\(Z73968\.R1A2B3C4\.SETTLE\)/);
  assert.doesNotMatch(blocks[1]!, /\bREPLACE\b/i, 'run-specific loading must not replace an existing/shared cluster');

  const creationEnd = jcl.indexOf('/*', jcl.indexOf('//SYSIN    DD *'));
  const loadStatement = jcl.indexOf('//VSAMLOAD EXEC PGM=IDCAMS');
  const loadEnd = jcl.indexOf('/*', jcl.indexOf('//SYSIN    DD *', loadStatement));
  const reconStatement = jcl.indexOf('//RECONCIL EXEC');
  assert.ok(creationEnd > 0 && creationEnd < loadStatement, 'cluster definition must terminate before the next JCL statement');
  assert.ok(loadEnd > loadStatement && loadEnd < reconStatement, 'REPRO controls must terminate before the next JCL statement');
});

test('parses actual COBOL counts and rejects missing spool or inconsistent counts', () => {
  assert.deepEqual(parseCobolCounts(spool), counts);
  assert.throws(() => parseCobolCounts('job completed RC=0'), /Required COBOL count is missing/);
  assert.match(countConsistencyError({ ...counts, transactionCount: 4 }) ?? '', /does not equal/);
});

test('EOD publication fails closed for exceptions, duplicate settlement keys and count mismatches', () => {
  const actualOutputCounts = { matchedCount: 5, mismatchedCount: 0, transactionOnlyCount: 0, settlementOnlyCount: 0 };
  assert.equal(eodPublicationAllowed(0, counts, actualOutputCounts, 0), true);
  assert.equal(eodPublicationAllowed(4, counts, actualOutputCounts, 0), false);
  assert.equal(eodPublicationAllowed(0, counts, actualOutputCounts, 1), false);
  assert.equal(eodPublicationAllowed(0, counts, { ...actualOutputCounts, matchedCount: 4 }, 0), false);
  const eod = generateEodJcl(plan('R1A2B3C4'), parseCobolCounts(spool), 4);
  assert.ok(eod.split('\n').every((line) => line.length <= 71), 'JCL cards must fit the standard 71-column statement area.');
  assert.match(eod, /COUNT FROM\(MATCHIN\) NOTEQUAL\(5\) RC8/);
  assert.match(eod, /COUNT FROM\(TXNIN\) NOTEQUAL\(5\) RC8/);
  assert.match(eod, /&RECONRC = 0/);
  assert.match(eod, /EOD VALIDATION FAILED - FINAL OUTPUT NOT PUBLISHED/);
  assert.doesNotMatch(eod, /Z73968\.BANK\.FINAL/);
  assert.throws(() => generateEodJcl(plan('R1A2B3C4'), { ...counts, transactionCount: 4 }, 0), /inconsistent COBOL counts/);
});

test('builds metadata-driven five-record and 10K non-executable previews with actual counts', () => {
  const smoke = preview(5, 5);
  const volume = preview(10_000, 10_000, 'Q1W2E3R4');
  assert.equal(smoke.inputs.transaction.recordCount, 5);
  assert.equal(volume.inputs.transaction.recordCount, 10_000);
  assert.equal(smoke.executable, false);
  assert.equal(volume.executable, false);
  const eodStep = volume.steps.find((step) => step.name.startsWith('EOD'));
  assert.equal(eodStep?.jcl, null, 'EOD JCL cannot be generated before actual COBOL counts exist.');
  assert.ok(eodStep?.checks.some((item) => item.includes('actual COBOL output')));
  assert.match(volume.steps.find((step) => step.name.startsWith('Sort'))?.jcl ?? '', /SUM FIELDS=NONE/);
  const tenKCounts: CobolCounts = { transactionCount: 10_000, settlementCount: 10_000, matchedCount: 10_000, mismatchedCount: 0, transactionOnlyCount: 0, settlementOnlyCount: 0 };
  const tenKEod = generateEodJcl(plan('Q1W2E3R4'), tenKCounts, 0);
  assert.match(tenKEod, /COUNT FROM\(TXNIN\) NOTEQUAL\(10000\) RC8/);
  assert.match(tenKEod, /COUNT FROM\(MATCHIN\) NOTEQUAL\(10000\) RC8/);
  assert.doesNotMatch(tenKEod, /NOTEQUAL\(5\)/);
});

test('preview validates metadata, exposes exact run-scoped datasets and duplicate settlement gate', () => {
  const result = preview(5, 5);
  assert.throws(() => buildExecutionPlanPreview({ ...{
    runId: result.runId, organization: result.organization, profile: result.profile as 'SMOKE', transaction: { ...result.inputs.transaction, size: 1 }, settlement: result.inputs.settlement, config,
  } }), /metadata is invalid/);
  assert.match(result.steps.find((step) => step.name.startsWith('Sort'))?.checks.join(' ') ?? '', /DUPCNT RC=0 means zero duplicates and RC8 fails/);
  assert.match(result.steps.find((step) => step.name.startsWith('Sort'))?.purpose ?? '', /preserve settlement duplicates/);
  const ownNames = new Set(Object.values(result.plan.datasets));
  for (const dsn of [...result.cleanupManifest.temporaryDatasetCandidates, ...result.cleanupManifest.retainedDatasetCandidates]) assert.ok(ownNames.has(dsn));
  assert.equal(result.cleanupManifest.automaticCleanupEnabled, false);
  assert.equal(result.cleanupManifest.state, 'PLANNED_NOT_CREATED');
  assert.equal(result.datasets.length, 14);
  for (const item of result.datasets) {
    assert.ok(item.name.length <= 44);
    assert.ok(item.name.split('.').every((q) => q.length >= 1 && q.length <= 8));
    assert.equal(item.state, 'PLANNED_NOT_CREATED');
  }
});

test('preview refuses invalid names instead of repairing generated configuration', () => {
  assert.throws(() => buildExecutionPlanPreview({
    runId: 'REC-20261023-0123456789ABCDEF0123', organization: { id: 'org-1', name: 'Example Bank' }, profile: 'SMOKE',
    transaction: { originalName: 'a.txt', size: 200, recordCount: 5, valid: true }, settlement: { originalName: 'b.txt', size: 200, recordCount: 5, valid: true },
    config: { ...config, loadLibrary: 'Z73968.BAD-LIBRARY' }, token: 'R1A2B3C4',
  }), /valid z\/OS dataset name/);
  assert.throws(() => buildExecutionPlanPreview({
    runId: 'REC-20261023-0123456789ABCDEF0123', organization: { id: 'org-1', name: 'Example Bank' }, profile: 'SMOKE',
    transaction: { originalName: 'a.txt', size: 200, recordCount: 5, valid: true }, settlement: { originalName: 'b.txt', size: 200, recordCount: 5, valid: true },
    config: { ...config, hlq: 'ZXP' }, token: 'R1A2B3C4',
  }), /must use the assigned Z73968 HLQ/);
});

test('input and output allocations scale deterministically through the documented upload maximum', () => {
  const five = preview(5, 5).plan.allocation;
  const tenK = preview(10_000, 10_000, 'Q1W2E3R4').plan.allocation;
  const maxRecords = Math.floor(MAX_UPLOAD_BYTES / 40);
  const max = buildExecutionPlanPreview({ runId:'REC-20261023-0123456789ABCDEF0123',organization:{id:'org-1',name:'Example Bank'},profile:'VOLUME_10K',transaction:{originalName:'max-txn.txt',size:MAX_UPLOAD_BYTES,recordCount:maxRecords,valid:true},settlement:{originalName:'max-set.txt',size:MAX_UPLOAD_BYTES,recordCount:maxRecords,valid:true},config,token:'M1N2B3C4' }).plan.allocation;
  assert.equal(five.transactionInputTracks, 1);
  assert.ok(tenK.transactionInputTracks > five.transactionInputTracks);
  assert.equal(max.maximumUploadBytes, MAX_UPLOAD_BYTES);
  assert.equal(max.transactionInputTracks, Math.ceil(MAX_UPLOAD_BYTES * 1.25 / TRACK_BYTES_3390));
  assert.ok(max.transactionInputTracks <= 232);
  assert.ok(max.mismatchTracks > max.transactionInputTracks, '120-byte mismatch records reserve proportionally more tracks.');
  assert.ok(max.settlementVsamPrimaryTracks > 0 && max.settlementVsamSecondaryTracks > 0);
  assert.throws(() => buildExecutionPlanPreview({ runId:'REC-20261023-0123456789ABCDEF0123',organization:{id:'org-1',name:'Example Bank'},profile:'SMOKE',transaction:{originalName:'over.txt',size:MAX_UPLOAD_BYTES+1,recordCount:5,valid:true},settlement:{originalName:'set.txt',size:200,recordCount:5,valid:true},config,token:'M1N2B3C4' }), /metadata is invalid/);
});

test('computes exact implied-decimal totals only from valid downloaded MATCHOUT records', () => {
  const row=(amount:string)=>`TXN0000001ACCT000001${amount}20260101A`;
  const bytes=Buffer.from(`${row('000001234')}\n${row('000000066')}\n`,'ascii');
  assert.equal(aggregateMatchedAmountCents(bytes),1300n);
  assert.equal(countDownloadedRecords(bytes,38),2);
  assert.equal(countDownloadedRecords(Buffer.alloc(0),38),0);
  assert.throws(()=>aggregateMatchedAmountCents(Buffer.from(`${row('00000X234')}\n`,'ascii')),/MATCHOUT record 1/);
  assert.throws(()=>countDownloadedRecords(Buffer.from('short\n','ascii'),120),/FB\/120/);
});

test('cross-job progression requires actual JES OUTPUT status and accepted RC zero', () => {
  assert.doesNotThrow(() => assertSuccessfulJesJob({ jobId: 'JOB12345', status: 'OUTPUT', returnCode: 0 }, 'preflight'));
  assert.throws(() => assertSuccessfulJesJob({ jobId: 'JOB12345', status: 'ACTIVE', returnCode: 0 }, 'preflight'), /JES must report a completed OUTPUT job with return code 0/);
  assert.throws(() => assertSuccessfulJesJob({ jobId: 'JOB12345', status: 'OUTPUT', returnCode: 8 }, 'preflight'), /JES must report a completed OUTPUT job with return code 0/);
  assert.throws(() => assertSuccessfulJesJob({ jobId: '', status: 'OUTPUT', returnCode: 0 }, 'preflight'), /JES must report/);
});

test('generated plan JCL and cleanup candidates remain run-scoped and contain no destructive cleanup', () => {
  const current = plan('R1A2B3C4');
  const allJcl = [generateAllocationJcl(current), generatePreflightJcl(current), generateReconciliationJcl(current), generateEodJcl(current, counts, 0)].join('\n');
  assert.doesNotMatch(allJcl, /Z73968\.BANK\./i);
  assert.doesNotMatch(allJcl, /DISP\s*=\s*DELETE/i);
  const referenced = [...allJcl.matchAll(/DSN=([^,\s]+)/g)].map((match) => match[1]);
  for (const dsn of referenced) assert.ok(Object.values(current.datasets).includes(dsn as typeof current.datasets[keyof typeof current.datasets]) || dsn === current.config.loadLibrary, `unexpected dataset reference ${dsn}`);
  const previewResult = preview(5, 5);
  const runDatasets = new Set(Object.values(previewResult.plan.datasets));
  assert.ok(previewResult.cleanupManifest.temporaryDatasetCandidates.every((dsn) => runDatasets.has(dsn)));
  assert.ok(previewResult.cleanupManifest.retainedDatasetCandidates.every((dsn) => runDatasets.has(dsn)));
  assert.equal(previewResult.cleanupManifest.automaticCleanupEnabled, false);
});

test('ambiguous COBOL summaries and business discrepancies never pass clean publication gates',()=>{
 const counts={transactionCount:10000,settlementCount:10000,matchedCount:9990,mismatchedCount:10,transactionOnlyCount:0,settlementOnlyCount:0};
 assert.equal(eodPublicationAllowed(0,counts,{matchedCount:9990,mismatchedCount:10,transactionOnlyCount:0,settlementOnlyCount:0},0),false);
 assert.throws(()=>parseCobolCounts('TRANSACTION INPUT COUNT: 10000\nTRANSACTION INPUT COUNT: 9999'),/Ambiguous duplicate/);
});
