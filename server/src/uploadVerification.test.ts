import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_UPLOAD_BYTES } from './executionPlan.js';
import { buildUploadVerificationPlan, executeUploadVerification, normalizeFixedWidthRecords, retryUploadVerificationCleanup, safeUploadVerificationResponse, validateSmokeConfiguration, type SmokeAdapter, type UploadVerificationRecord } from './uploadVerification.js';

const line = 'T000000001A00000000100001234520261023A';
const other = 'S000000001A00000000100001234520261023A';
assert.equal(Buffer.byteLength(line), 38);
const enabled = { MAINFRAME_ENABLED: 'true', MAINFRAME_AUTH_READY: 'true', MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED:'true', MAINFRAME_UPLOAD_TEST_REVIEWED:'true', MAINFRAME_HLQ: 'Z73968', MAINFRAME_JOB_CLASS: '7', MAINFRAME_SOURCE_LIBRARY: 'Z73968.SOURCE', MAINFRAME_LOAD_LIBRARY: 'Z73968.LOAD', MAINFRAME_ENDPOINT: 'https://mf.example.test' };

async function fixture(options: { txn?: Buffer; set?: Buffer; fail?: string; wrongAttrs?: boolean; cleanupFail?: boolean; collision?: boolean; preflightError?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledgerline-smoke-'));
  const txn = options.txn ?? Buffer.from(`${line}\r\n`);
  const set = options.set ?? Buffer.from(`${other}\n`);
  const txnId = '11111111-1111-4111-8111-111111111111'; const setId = '22222222-2222-4222-8222-222222222222';
  const txnPath = path.join(root, `${txnId}.txt`); const setPath = path.join(root, `${setId}.txt`);
  await fs.writeFile(txnPath, txn); await fs.writeFile(setPath, set);
  const plan = buildUploadVerificationPlan({ hlq: 'Z73968', transaction: { size: txn.length, recordCount: 1 }, settlement: { size: set.length, recordCount: 1 }, randomBytes: () => Buffer.alloc(8, 1) });
  const record: UploadVerificationRecord = {
    operationId: '33333333-3333-4333-8333-333333333333', organizationId: 'aaaaaaaaaaaaaaaaaaaaaaaa', organizationName: 'Example Bank', actorId: 'operator', runQualifier: plan.runQualifier,
    transaction: { uploadId: txnId, kind: 'transaction', originalName: 'transactions.txt', size: txn.length, sha256: crypto.createHash('sha256').update(txn).digest('hex'), recordCount: 1, valid: true, stagedPath: txnPath },
    settlement: { uploadId: setId, kind: 'settlement', originalName: 'settlements.txt', size: set.length, sha256: crypto.createHash('sha256').update(set).digest('hex'), recordCount: 1, valid: true, stagedPath: setPath },
    datasets: plan.datasets, status: 'PREPARED', stage: 'PREPARED', stageResults: {},
  };
  const remote = new Map<string, Buffer>(); const calls: string[] = []; const transferPaths: string[] = []; const uploadedBytes: Buffer[] = [];
  const adapter: SmokeAdapter = {
    async attributes(dataset) { calls.push(`attributes:${dataset}`); if (!remote.has(dataset)) { if (options.preflightError) throw Object.assign(new Error('collision preflight inconclusive'), { code: options.preflightError }); if (options.collision && dataset === record.datasets[0]?.name) return { dsname: dataset, dsorg: 'PS', recfm: 'FB', lrecl: 38 }; throw Object.assign(new Error('dataset not found'), { code: 'DATASET_NOT_FOUND' }); } return { dsname: dataset, dsorg: 'PS', recfm: 'FB', lrecl: options.wrongAttrs ? 80 : 38 }; },
    async create(dataset) { calls.push(`create:${dataset}`); if (options.fail === `create:${dataset}`) throw Object.assign(new Error('timeout token=hidden'), { code: 'TIMEOUT' }); if (options.fail === 'create:second' && dataset === record.datasets[1]?.name) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); remote.set(dataset, Buffer.alloc(0)); },
    async upload(dataset, stagedPath) { calls.push(`upload:${dataset}`); transferPaths.push(stagedPath); if (options.fail === `upload:${dataset}` || options.fail === 'upload') throw Object.assign(new Error('upload denied'), { code: 'AUTHORIZATION' }); const bytes = await fs.readFile(stagedPath); uploadedBytes.push(bytes); remote.set(dataset, bytes); },
    async download(dataset, localPath) { calls.push(`download:${dataset}`); if (options.fail === 'download') throw Object.assign(new Error('download timeout'), { code: 'TIMEOUT' }); const bytes = remote.get(dataset); if (!bytes) throw new Error('missing remote dataset'); const content = options.fail === `content:${dataset}` ? Buffer.from(`${other}\n`) : options.fail === 'count' ? Buffer.from(`${line}\n${other}\n`) : bytes; await fs.writeFile(localPath, content); },
    async delete(dataset) { calls.push(`delete:${dataset}`); if (options.cleanupFail) throw Object.assign(new Error('permission denied'), { code: 'AUTHORIZATION' }); remote.delete(dataset); },
  };
  const saves: UploadVerificationRecord[] = [];
  const deps = { env: enabled, stagingRoot: root, adapter, checkReadiness: async () => ({ state: 'DATASET_ACCESS_VERIFIED' }), persist: async (value: UploadVerificationRecord) => { saves.push(structuredClone(value)); }, randomBytes: () => Buffer.alloc(8, 1) };
  return { root, txnPath, setPath, txn, set, record, adapter, remote, calls, transferPaths, uploadedBytes, saves, deps };
}

test('generates unique-format, bounded dataset names and size-based allocation', () => {
  const small = buildUploadVerificationPlan({ hlq: 'Z73968', transaction: { size: 200, recordCount: 5 }, settlement: { size: 400_000, recordCount: 10_000 }, randomBytes: () => Buffer.alloc(8, 2) });
  assert.match(small.runQualifier, /^U[A-Z0-9]{7}$/);
  assert.ok(small.datasets.every((item) => item.name.split('.').every((part) => part.length <= 8)));
  assert.ok(small.primaryTracks.settlement > small.primaryTracks.transaction);
  assert.ok(small.primaryTracks.settlement <= 232);
  assert.notEqual(small.runQualifier, buildUploadVerificationPlan({ hlq: 'Z73968', transaction: { size: 200, recordCount: 5 }, settlement: { size: 400_000, recordCount: 10_000 }, randomBytes: () => Buffer.alloc(8, 3) }).runQualifier);
  const maximum = buildUploadVerificationPlan({ hlq:'Z73968', transaction:{size:MAX_UPLOAD_BYTES,recordCount:Math.floor(MAX_UPLOAD_BYTES/39)}, settlement:{size:MAX_UPLOAD_BYTES,recordCount:Math.floor(MAX_UPLOAD_BYTES/39)}, randomBytes:()=>Buffer.alloc(8,4) });
  assert.deepEqual(maximum.primaryTracks,{transaction:232,settlement:232});
  assert.throws(()=>buildUploadVerificationPlan({hlq:'Z73968',transaction:{size:0,recordCount:1},settlement:{size:39,recordCount:1}}),/metadata is invalid/);
});

test('rejects missing execution gates and invalid configuration', () => {
  assert.throws(() => validateSmokeConfiguration({ ...enabled, MAINFRAME_ENABLED: 'false' }), /disabled/);
  assert.throws(() => validateSmokeConfiguration({ ...enabled, MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED:'false' }), /explicitly accept the local zosmf profile TLS risk for this upload-verification smoke test/);
  assert.throws(() => validateSmokeConfiguration({ ...enabled, MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED: undefined, MAINFRAME_TLS_REVIEWED: 'true' }), /explicitly accept the local zosmf profile TLS risk for this upload-verification smoke test/);
  assert.throws(() => validateSmokeConfiguration({ ...enabled, MAINFRAME_UPLOAD_TEST_REVIEWED:'false' }), /mainframe owner must approve/);
  assert.throws(() => validateSmokeConfiguration({ ...enabled, MAINFRAME_HLQ: 'BAD.HLQ' }), /missing or invalid/);
  assert.throws(() => validateSmokeConfiguration({ ...enabled, MAINFRAME_ENDPOINT: 'http://mf.example.test' }), /HTTPS/);
});

test('normalizes Windows CRLF, LF, mixed delimiters and optional trailing newline without changing record bytes', () => {
  assert.deepEqual(normalizeFixedWidthRecords(Buffer.from(`${line}\r\n${other}\r\n`)), [line, other]);
  assert.deepEqual(normalizeFixedWidthRecords(Buffer.from(`${line}\n${other}\n`)), [line, other]);
  assert.deepEqual(normalizeFixedWidthRecords(Buffer.from(`${line}\n${other}`)), [line, other]);
  assert.deepEqual(normalizeFixedWidthRecords(Buffer.from(`${line}\r\n${other}\n${line}`)), [line, other, line]);
  assert.throws(() => normalizeFixedWidthRecords(Buffer.from(`${line.slice(0, 37)}\n`)), /record length/);
  assert.throws(() => normalizeFixedWidthRecords(Buffer.from(`${line}\n\n`)), /record length/);
  assert.throws(() => normalizeFixedWidthRecords(Buffer.from(`${line}\r`)), /record length/);
  assert.throws(() => normalizeFixedWidthRecords(Buffer.alloc(0)), /empty/);
});

test('completes a mocked allocation, text upload, FB/38 attribute and read-back verification, then exact cleanup', async () => {
  const f = await fixture();
  f.remote.set('Z73968.QATST901.TXNIN', Buffer.from('manually managed diagnostic dataset'));
  try {
    const result = await executeUploadVerification(f.record, f.deps);
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.stageResults.transactionVerification && (result.stageResults.transactionVerification as { readBackRecordCount: number }).readBackRecordCount, 1);
    assert.equal(result.datasets.every((item) => item.state === 'CLEANED'), true);
    assert.equal(f.remote.size, 1);
    assert.ok(f.calls.some((call) => call.startsWith('upload:')));
    assert.ok(f.calls.some((call) => call.startsWith('download:')));
    assert.equal(f.saves.some((saved) => saved.datasets.some((dataset) => dataset.state === 'CREATED')), true);
    assert.deepEqual(f.uploadedBytes, [Buffer.from(`${line}\n`, 'ascii'), Buffer.from(`${other}\n`, 'ascii')]);
    assert.deepEqual(await fs.readFile(f.txnPath), f.txn);
    assert.deepEqual(await fs.readFile(f.setPath), f.set);
    for (const transferPath of f.transferPaths) await assert.rejects(() => fs.access(transferPath), { code: 'ENOENT' });
    assert.equal(f.remote.has('Z73968.QATST901.TXNIN'), true);
    assert.deepEqual(f.calls.filter((call) => call.startsWith('delete:')), f.record.datasets.map((dataset) => `delete:${dataset.name}`));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('rejects missing staged files, hash mismatches and invalid records before remote writes', async () => {
  const missing = await fixture();
  try {
    await fs.unlink(missing.txnPath);
    await assert.rejects(() => executeUploadVerification(missing.record, missing.deps), /ENOENT|missing/i);
    assert.equal(missing.calls.some((call) => call.startsWith('create:')), false);
  } finally { await fs.rm(missing.root, { recursive: true, force: true }); }
  const changed = await fixture();
  try {
    await fs.writeFile(changed.txnPath, Buffer.from(`${other}\n`));
    await assert.rejects(() => executeUploadVerification(changed.record, changed.deps), /size changed|hash/i);
    assert.equal(changed.calls.some((call) => call.startsWith('create:')), false);
  } finally { await fs.rm(changed.root, { recursive: true, force: true }); }
  const invalid = await fixture({ txn: Buffer.from(`${'!'.repeat(38)}\n`) });
  try { await assert.rejects(() => executeUploadVerification(invalid.record, invalid.deps), /fixed-width/); assert.equal(invalid.calls.some((call) => call.startsWith('create:')), false); }
  finally { await fs.rm(invalid.root, { recursive: true, force: true }); }
  for (const unsupported of [Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from(`${line}\n`)]), Buffer.from(line, 'utf16le')]) {
    const f = await fixture();
    try {
      await fs.writeFile(f.txnPath, unsupported);
      f.record.transaction.size = unsupported.length;
      f.record.transaction.sha256 = crypto.createHash('sha256').update(unsupported).digest('hex');
      await assert.rejects(() => executeUploadVerification(f.record, f.deps), /fixed-width/);
      assert.equal(f.calls.some((call) => call.startsWith('create:') || call.startsWith('upload:')), false);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

test('checks collisions for both exact names before allocating either dataset', async () => {
  const f = await fixture({ collision: true });
  try {
    const result = await executeUploadVerification(f.record, f.deps);
    assert.equal(result.status, 'FAILED'); assert.equal(result.errorCategory, 'DATASET_COLLISION');
    assert.equal(result.stage, 'DATASET_COLLISION_CHECK');
    assert.deepEqual(result.datasets.map((item) => item.state), ['PLANNED', 'PLANNED']);
    assert.equal((result.stageResults.failure as { stage: string }).stage, 'DATASET_COLLISION_CHECK');
    assert.equal(f.calls.some((call) => call.startsWith('create:')), false);
    assert.equal(f.calls.some((call) => call.startsWith('delete:')), false);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('preserves collision-preflight failure stage and planned manifest when absence is inconclusive', async () => {
  for (const category of ['RFJ_RESOURCE_INVALID', 'AUTHORIZATION', 'TIMEOUT']) {
    const f = await fixture({ preflightError: category });
    try {
      const result = await executeUploadVerification(f.record, f.deps);
      assert.equal(result.status, 'FAILED');
      assert.equal(result.errorCategory, category);
      assert.equal(result.stage, 'DATASET_COLLISION_CHECK');
      assert.equal((result.stageResults.failure as { stage: string }).stage, 'DATASET_COLLISION_CHECK');
      assert.deepEqual(result.datasets.map((item) => item.state), ['PLANNED', 'PLANNED']);
      assert.equal(f.calls.some((call) => call.startsWith('create:') || call.startsWith('delete:')), false);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

test('partial allocation failure cleans only the confirmed created dataset and preserves unknown outcome', async () => {
  const f = await fixture({ fail: 'create:second' });
  try {
    const result = await executeUploadVerification(f.record, f.deps);
    assert.equal(result.status, 'CLEANUP_FAILED');
    assert.deepEqual(result.datasets.map((item) => item.state), ['CLEANED', 'UNKNOWN']);
    assert.doesNotMatch(JSON.stringify(safeUploadVerificationResponse(result)), /hidden|stagedPath|C:\\|staging/i);
    assert.deepEqual(f.calls.filter((call) => call.startsWith('delete:')), [`delete:${f.record.datasets[0]!.name}`]);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('upload failure is persisted and cleanup remains restricted to this operation manifest', async () => {
  const f = await fixture({ fail: 'upload' });
  try {
    const result = await executeUploadVerification(f.record, f.deps);
    assert.equal(result.status, 'FAILED'); assert.equal(result.errorCategory, 'AUTHORIZATION');
    assert.equal(result.datasets.every((item) => item.state === 'CLEANED'), true);
    assert.equal(f.calls.filter((call) => call.startsWith('delete:')).length, 2);
    assert.doesNotMatch(JSON.stringify(safeUploadVerificationResponse(result)), /hidden|stagedPath|C:\\|staging/i);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('removes normalized transfer copies after a partial upload failure', async () => {
  const options: { fail?: string } = {};
  const f = await fixture(options);
  options.fail = `upload:${f.record.datasets[1]!.name}`;
  f.remote.set('Z73968.QATST901.TXNIN', Buffer.from('manually managed diagnostic dataset'));
  try {
    const result = await executeUploadVerification(f.record, f.deps);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCategory, 'AUTHORIZATION');
    assert.equal(f.transferPaths.length, 2);
    assert.equal(f.uploadedBytes.length, 1);
    for (const transferPath of f.transferPaths) await assert.rejects(() => fs.access(transferPath), { code: 'ENOENT' });
    assert.deepEqual(f.calls.filter((call) => call.startsWith('delete:')), f.record.datasets.map((dataset) => `delete:${dataset.name}`));
    assert.equal(f.remote.has('Z73968.QATST901.TXNIN'), true);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('attribute, read-back count/content and cleanup failures are reported without false success', async () => {
  for (const option of [{ wrongAttrs: true }, { fail: 'download' }, { fail: 'count' }, { cleanupFail: true }]) {
    const f = await fixture(option);
    try {
      const result = await executeUploadVerification(f.record, f.deps);
      if ('cleanupFail' in option) assert.equal(result.status, 'VERIFIED_WITH_CLEANUP_WARNING');
      else assert.equal(result.status, 'FAILED');
      if ('cleanupFail' in option) assert.equal(result.datasets.some((item) => item.state === 'CLEANUP_FAILED'), true);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
  const mismatch = await fixture({ fail: `content:Z73968.${buildUploadVerificationPlan({ hlq:'Z73968', transaction:{size:40,recordCount:1}, settlement:{size:39,recordCount:1}, randomBytes:()=>Buffer.alloc(8,1) }).runQualifier}.TXNIN` });
  try { const result = await executeUploadVerification(mismatch.record, mismatch.deps); assert.equal(result.status, 'FAILED'); assert.equal(result.errorCategory, 'READBACK_CONTENT_MISMATCH'); }
  finally { await fs.rm(mismatch.root, { recursive: true, force: true }); }
});

test('cleanup retry only invokes exact run-owned manifest names and is idempotent', async () => {
  const f = await fixture();
  try {
    await executeUploadVerification(f.record, f.deps);
    f.calls.length = 0;
    const result = await retryUploadVerificationCleanup(f.record, f.deps);
    assert.equal(result.status, 'VERIFIED');
    assert.deepEqual(f.calls, []);
    const forged = structuredClone(f.record); forged.datasets[0]!.name = 'Z73968.BANK.TXN10K';
    await assert.rejects(() => retryUploadVerificationCleanup(forged, f.deps), /manifest failed ownership validation/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('does not continue when read-only profile readiness fails', async () => {
  const f = await fixture();
  try { await assert.rejects(() => executeUploadVerification(f.record, { ...f.deps, checkReadiness: async () => ({ state: 'CONNECTION_FAILED', message: 'connection unavailable' }) }), /connection unavailable/); assert.equal(f.calls.some((call) => call.startsWith('create:')), false); }
  finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
