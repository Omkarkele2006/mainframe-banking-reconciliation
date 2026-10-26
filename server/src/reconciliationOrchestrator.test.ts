import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRunExecutionPlan, createRunId, createDatasetToken, generateAllocationJcl, generatePreflightJcl, generateReconciliationJcl, generateEodJcl } from './executionPlan.js';
import { assertRunScopedJclContract, createReconciliationOperation, executeReconciliation, reconciliationReadinessBlockers, type ReconciliationOperation, type ReconciliationReadinessEvidence, type ReconciliationRemote, type ReconciliationStore } from './reconciliationOrchestrator.js';

const record = 'TXN0000001ACCT00000100005000020261023A';
const counts = ['TRANSACTION INPUT COUNT: 0000001','SETTLEMENT INPUT COUNT:  0000001','MATCHED COUNT:           0000001','MISMATCHED COUNT:        0000000','TRANSACTION-ONLY COUNT:  0000000','SETTLEMENT-ONLY COUNT:   0000000'].join('\n');
const configuration = { hlq: 'Z73968', jobClass: '7', sourceLibrary: 'Z73968.SOURCE', loadLibrary: 'Z73968.LOAD', loadModule: 'RECONCIL', rexxMember: 'VALIDATE' };

class MemoryStore implements ReconciliationStore {
  value?: ReconciliationOperation; saves = 0;
  async createIfAbsent(operation: ReconciliationOperation) { if (this.value) return false; this.value = operation; return true; }
  async save(operation: ReconciliationOperation) { this.value = operation; this.saves += 1; }
  async get() { return this.value; }
}

async function fixture(options: { duplicate?: boolean; timeout?: boolean; gate?: boolean; moduleVerified?: boolean; collision?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledgerline-run-'));
  const idTxn = crypto.randomUUID(); const idSet = crypto.randomUUID();
  const bytes = Buffer.from(`${record}\r\n`, 'ascii');
  const txnPath = path.join(root, `${idTxn}.txt`); const setPath = path.join(root, `${idSet}.txt`);
  await fs.writeFile(txnPath, bytes); await fs.writeFile(setPath, bytes);
  const input = (uploadId: string, stagedPath: string, originalName: string) => ({ uploadId, stagedPath, originalName, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), recordCount: 1, valid: true });
  const runId = createRunId(new Date('2026-10-25T00:00:00.000Z'));
  const plan = buildRunExecutionPlan(runId, configuration, createDatasetToken(), { transaction: { originalName: 'txn.txt', size: bytes.length, recordCount: 1, valid: true }, settlement: { originalName: 'set.txt', size: bytes.length, recordCount: 1, valid: true } });
  const operation = createReconciliationOperation({ runId, idempotencyKey: 'idempotency-key-0001', organizationId: '507f1f77bcf86cd799439011', organizationName: 'Example Bank', actorId: 'operator', profile: 'SMOKE', transaction: input(idTxn, txnPath, 'txn.txt'), settlement: input(idSet, setPath, 'set.txt'), plan });
  const store = new MemoryStore(); const created = new Set<string>(); const uploads = new Map<string, Buffer>(); const submitted: string[] = []; const deleted: string[] = []; const remoteTouches: string[] = []; let readinessChecks = 0; let jobNumber = 0; let statusReads = 0;
  const duplicateBytes = options.duplicate ? Buffer.from(`${record}\n`, 'ascii') : Buffer.alloc(0);
  const remote: ReconciliationRemote = {
    async attributes(dataset) { remoteTouches.push(`attributes:${dataset}`); if (options.collision && dataset === plan.datasets.TXNIN) return { dsname: dataset, dsorg: 'PS', recfm: 'FB', lrecl: 38 }; if (!created.has(dataset)) throw Object.assign(new Error('absent'), { code: 'DATASET_NOT_FOUND' }); return { dsname: dataset, dsorg: dataset.endsWith('.SETTLE') ? 'VS' : 'PS', recfm: 'FB', lrecl: 38 }; },
    async createSequential() { remoteTouches.push('createSequential'); throw new Error('not expected'); },
    async uploadSequential(dataset, localPath) { remoteTouches.push(`upload:${dataset}`); uploads.set(dataset, await fs.readFile(localPath)); },
    async downloadDataset(dataset, localPath) {
      remoteTouches.push(`download:${dataset}`);
      const data = dataset === plan.datasets.DUPES ? duplicateBytes
        : dataset === plan.datasets.TXNIN ? uploads.get(dataset)!
          : dataset === plan.datasets.SETIN ? uploads.get(dataset)!
            : ['TXNSORT','SETSORT','MATCHOUT','FINAL'].some((suffix) => dataset.endsWith(`.${suffix}`)) ? Buffer.from(`${record}\n`, 'ascii') : Buffer.alloc(0);
      await fs.writeFile(localPath, data);
    },
    async deleteDataset(dataset) { remoteTouches.push(`delete:${dataset}`); deleted.push(dataset); created.delete(dataset); },
    async deleteVsamCluster(dataset) { remoteTouches.push(`deleteVsam:${dataset}`); deleted.push(dataset); created.delete(dataset); created.delete(plan.datasets.SETTLE_DATA); created.delete(plan.datasets.SETTLE_INDEX); },
    async submitJcl(localPath) {
      remoteTouches.push('submitJcl');
      const jcl = await fs.readFile(localPath, 'utf8'); submitted.push(jcl); jobNumber += 1;
      if (jcl.includes('//ALLOC')) for (const key of ['TXNIN','SETIN'] as const) created.add(plan.datasets[key]);
      if (jcl.includes('//TXNSORT')) for (const key of ['TXNSORT','SETSORT','DUPES'] as const) created.add(plan.datasets[key]);
      if (jcl.includes('//VSAMCRT')) for (const key of ['SETTLE','SETTLE_DATA','SETTLE_INDEX','MATCHOUT','MISMOUT','TXNMISS','SETMISS'] as const) created.add(plan.datasets[key]);
      if (jcl.includes('//PUBOK')) created.add(plan.datasets.FINAL);
      return { jobId: `JOB${String(jobNumber).padStart(5, '0')}` };
    },
    async jobStatus(jobId) { statusReads += 1; return { jobId, status: options.timeout && statusReads > 0 ? 'ACTIVE' : 'OUTPUT', returnCode: options.duplicate && jobNumber === 2 ? 8 : 0 }; },
    async jobSpool() { return jobNumber === 3 ? counts : jobNumber === 2 && options.duplicate ? 'duplicate preflight RC=8' : `job ${jobNumber} complete`; },
  };
  return { root, plan, operation, store, remote, submitted, deleted, uploads, remoteTouches, get readinessChecks() { return readinessChecks; }, run: (gate = options.gate ?? true) => executeReconciliation(operation, { store, remote, stagingRoot: root, executionGate: () => ({ canExecute: gate, blockers: gate ? [] : ['disabled by test gate'] }), readiness: async () => { readinessChecks += 1; return { state: 'DATASET_ACCESS_VERIFIED' }; }, verifyLoadModule: async (library, member) => { readinessChecks += 1; return options.moduleVerified === false ? ({ verified: false, message: 'RECONCIL member not verified.' }) : ({ verified: true, evidence: `${library}(${member}) verified by approved read-only check` }); }, maxJobWaitMs: options.timeout ? 0 : 5, pollIntervalMs: 1, sleep: async () => undefined }) };
}

test('readiness blocks missing run-specific sort inputs, unverified module, and present or unknown output names', async () => {
  const f = await fixture();
  try {
    const readyEvidence: ReconciliationReadinessEvidence = {
      sortedInputs: {
        TXNSORT: { dataset: f.plan.datasets.TXNSORT, state: 'PRESENT', dsorg: 'PS', recfm: 'FB', lrecl: 38 },
        SETSORT: { dataset: f.plan.datasets.SETSORT, state: 'PRESENT', dsorg: 'PS', recfm: 'FB', lrecl: 38 },
      },
      loadModule: { library: f.plan.config.loadLibrary, member: f.plan.config.loadModule, verified: true, evidence: 'read-only member verification' },
      outputConflicts: { SETTLE: 'ABSENT', SETTLE_DATA: 'ABSENT', SETTLE_INDEX: 'ABSENT', MATCHOUT: 'ABSENT', MISMOUT: 'ABSENT', TXNMISS: 'ABSENT', SETMISS: 'ABSENT' },
    };
    assert.deepEqual(reconciliationReadinessBlockers(f.plan, readyEvidence), []);
    const missingSort = reconciliationReadinessBlockers(f.plan, { ...readyEvidence, sortedInputs: { ...readyEvidence.sortedInputs, TXNSORT: { dataset: f.plan.datasets.TXNSORT, state: 'ABSENT' } } });
    assert.ok(missingSort.some((blocker) => blocker.includes(f.plan.datasets.TXNSORT)));
    const invalidSort = reconciliationReadinessBlockers(f.plan, { ...readyEvidence, sortedInputs: { ...readyEvidence.sortedInputs, SETSORT: { dataset: f.plan.datasets.SETSORT, state: 'PRESENT', dsorg: 'PS', recfm: 'FB', lrecl: 80 } } });
    assert.ok(invalidSort.some((blocker) => blocker.includes(f.plan.datasets.SETSORT) && blocker.includes('LRECL=38')));
    const moduleUnverified = reconciliationReadinessBlockers(f.plan, { ...readyEvidence, loadModule: { ...readyEvidence.loadModule, verified: false, evidence: undefined } });
    assert.ok(moduleUnverified.some((blocker) => blocker.includes('RECONCIL')));
    const outputConflict = reconciliationReadinessBlockers(f.plan, { ...readyEvidence, outputConflicts: { ...readyEvidence.outputConflicts, MATCHOUT: 'PRESENT' } });
    assert.ok(outputConflict.some((blocker) => blocker.includes(f.plan.datasets.MATCHOUT) && blocker.includes('name conflict')));
    const mismatchedModule = reconciliationReadinessBlockers(f.plan, { ...readyEvidence, loadModule: { ...readyEvidence.loadModule, member: 'OTHER' } });
    assert.ok(mismatchedModule.some((blocker) => blocker.includes('RECONCIL')));
    const unknownOutput = reconciliationReadinessBlockers(f.plan, { ...readyEvidence, outputConflicts: { ...readyEvidence.outputConflicts, SETMISS: 'UNKNOWN' } });
    assert.ok(unknownOutput.some((blocker) => blocker.includes(f.plan.datasets.SETMISS)));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('unverified RECONCIL member blocks before any dataset write or JCL submission', async () => {
  const f = await fixture({ moduleVerified: false });
  try {
    const result = await f.run();
    assert.equal(result.status, 'NOT_CONFIGURED');
    assert.equal(result.failure?.category, 'RECONCILIATION_READINESS_BLOCKED');
    assert.equal((result.stageResults.readinessPrerequisites as { state: string }).state, 'BLOCKED');
    assert.equal(f.submitted.length, 0);
    assert.equal(f.deleted.length, 0);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('persists a mocked complete run using only run-scoped Z73968 JCL and datasets', async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    assert.equal(result.status, 'COMPLETED', JSON.stringify({ stage: result.stage, failure: result.failure, diagnostics: result.diagnostics }));
    assert.equal(result.summary?.matchedCount, 1);
    assert.equal(result.summary?.matchedAmountCents, '50000');
    assert.equal(result.jobs.length, 4);
    assert.equal(result.jobs[0]?.jobId, 'JOB00001');
    assert.equal(f.uploads.get(f.plan.datasets.TXNIN)?.toString('ascii'), `${record}\n`);
    assert.equal(f.uploads.get(f.plan.datasets.SETIN)?.toString('ascii'), `${record}\n`);
    assert.ok(result.datasets.every((dataset) => dataset.name.startsWith(`Z73968.${f.plan.token}.`)));
    assert.ok(f.submitted.every((jcl) => !jcl.includes('ZXP.PUBLIC.') && !jcl.includes('Z73968.BANK.')));
    assert.ok(!f.deleted.includes(f.plan.datasets.FINAL));
    assert.ok(result.outputReferences.length >= 4);
    assert.ok(result.outputReferences.every((output) => output.key && output.localPath.startsWith(path.join(f.root, '.reports'))));
    for (const output of result.outputReferences) assert.equal(crypto.createHash('sha256').update(await fs.readFile(output.localPath)).digest('hex'), output.sha256, 'verified output copies must remain durable after temporary download cleanup');
    const duplicate = await f.run(); assert.equal(duplicate.jobs.length, 4, 'same idempotency key must not resubmit jobs');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('execution gate blocks before any remote operation and persists NOT_CONFIGURED', async () => {
  const f = await fixture({ gate: false });
  try { const result = await f.run(); assert.equal(result.status, 'NOT_CONFIGURED'); assert.equal(f.submitted.length, 0); assert.equal(f.store.saves > 0, true); }
  finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('duplicate settlement evidence blocks VSAM and COBOL and remains associated with its run', async () => {
  const f = await fixture({ duplicate: true });
  try { const result = await f.run(); assert.equal(result.status, 'BUSINESS_EXCEPTION', JSON.stringify({ stage: result.stage, failure: result.failure, diagnostics: result.diagnostics })); assert.equal(result.failure?.category, 'DUPLICATE_SETTLEMENT_KEYS'); assert.equal(f.submitted.length, 2); const evidence = result.outputReferences.find((output) => output.dataset === f.plan.datasets.DUPES); assert.ok(evidence); assert.equal(crypto.createHash('sha256').update(await fs.readFile(evidence!.localPath)).digest('hex'), evidence!.sha256); assert.equal(f.deleted.length, 0); }
  finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('unresolved JES state is persisted and never resubmitted', async () => {
  const f = await fixture({ timeout: true });
  try { const result = await f.run(); assert.equal(result.status, 'AWAITING_RECOVERY', JSON.stringify({ stage: result.stage, failure: result.failure, diagnostics: result.diagnostics })); assert.ok(result.jobs[0]?.jobId); assert.equal(f.submitted.length, 1); const same = await f.run(); assert.equal(same.status, 'AWAITING_RECOVERY'); assert.equal(f.submitted.length, 1); }
  finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('invalid namespace is rejected before a store record or remote command', async () => {
  const f = await fixture();
  try { const invalid = { ...f.operation, plan: { ...f.plan, config: { ...f.plan.config, hlq: 'ZXP' } } }; await assert.rejects(executeReconciliation(invalid, { store: f.store, remote: f.remote, stagingRoot: f.root, executionGate: () => ({ canExecute: true, blockers: [] }), readiness: async () => ({ state: 'DATASET_ACCESS_VERIFIED' }) }), /assigned Z73968 namespace/); assert.equal(f.submitted.length, 0); }
  finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('static JCL contract checks require run DSNs, deployed DD names, RC dependencies and dynamic EOD counts', async () => {
  const f = await fixture();
  try {
    assertRunScopedJclContract(f.plan, 'allocation', generateAllocationJcl(f.plan));
    assertRunScopedJclContract(f.plan, 'preflight', generatePreflightJcl(f.plan));
    assertRunScopedJclContract(f.plan, 'reconciliation', generateReconciliationJcl(f.plan));
    const counts = { transactionCount: 1, settlementCount: 1, matchedCount: 1, mismatchedCount: 0, transactionOnlyCount: 0, settlementOnlyCount: 0 };
    assertRunScopedJclContract(f.plan, 'eod', generateEodJcl(f.plan, counts, 0));
    assert.throws(() => assertRunScopedJclContract(f.plan, 'preflight', generatePreflightJcl(f.plan).replace('TXNSORT.RC = 0', 'TXNSORT.RC = 4')), /required source-backed contract/);
    assert.throws(() => assertRunScopedJclContract(f.plan, 'reconciliation', `${generateReconciliationJcl(f.plan)}\n//BAD DD DSN=Z73968.BANK.TXNTEST,DISP=SHR`), /shared\/baseline namespace/);
    assert.throws(() => assertRunScopedJclContract(f.plan, 'eod', generateEodJcl(f.plan, counts, 0).replace('NOTEQUAL(1)', 'NOTEQUAL(5)')), /actual run/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('preflight JCL maps uploaded transaction and settlement datasets to their matching run-scoped sort outputs', async () => {
  const f = await fixture();
  try {
    const jcl = generatePreflightJcl(f.plan);
    const cards = jcl.split('\n');
    assert.match(jcl, new RegExp(`//TXNSORT\\s+EXEC PGM=SORT[\\s\\S]*?//SORTIN\\s+DD DSN=${f.plan.datasets.TXNIN},DISP=SHR[\\s\\S]*?//SORTOUT\\s+DD DSN=${f.plan.datasets.TXNSORT}`));
    assert.match(jcl, new RegExp(`//SETSORT\\s+EXEC PGM=SORT[\\s\\S]*?//SORTIN\\s+DD DSN=${f.plan.datasets.SETIN},DISP=SHR[\\s\\S]*?//SORTOUT\\s+DD DSN=${f.plan.datasets.SETSORT}`));
    assert.ok(cards.includes(`//SORTOUT  DD DSN=${f.plan.datasets.TXNSORT},DISP=(NEW,CATLG,KEEP),`));
    assert.ok(cards.includes(`//SORTOUT  DD DSN=${f.plan.datasets.SETSORT},DISP=(NEW,CATLG,KEEP),`));
    assert.ok(cards.includes(`//DUPES    DD DSN=${f.plan.datasets.DUPES},DISP=(NEW,CATLG,KEEP),`));
    assert.ok(cards.includes(`//IFSET    IF (SETSORT.RC = 0) THEN`));
    assert.ok(cards.includes(`//IFDUP    IF (DUPSEL.RC = 0) THEN`));
    assert.ok(cards.includes(`//IFTXN    IF (TXNSORT.RC = 0) THEN`));
    assert.match(jcl, new RegExp(`//SETIN\\s+DD DSN=${f.plan.datasets.SETSORT},DISP=SHR`));
    assert.match(jcl, /SORT FIELDS=\(1,10,CH,A\)/);
    assert.match(jcl, /SUM FIELDS=NONE/);
    assert.match(jcl, /SELECT FROM\(SETIN\) TO\(DUPES\) ON\(1,10,CH\) ALLDUPS/);
    assert.match(jcl, /COUNT FROM\(DUPIN\) NOTEQUAL\(0\) RC8/);
    assert.match(jcl, /IFTXN\s+IF \(TXNSORT\.RC = 0\) THEN[\s\S]*?SETSORT\s+EXEC[\s\S]*?IFSET\s+IF \(SETSORT\.RC = 0\) THEN[\s\S]*?DUPSEL\s+EXEC[\s\S]*?IFDUP\s+IF \(DUPSEL\.RC = 0\) THEN[\s\S]*?DUPCNT\s+EXEC/);
    assert.doesNotMatch(jcl, /^\/\/(?:SORTOUT|IFSET)DD\b/m, 'statement name and operation fields must remain separated');
    assert.doesNotMatch(jcl, /Z73968\.BANK\.|ZXP\.PUBLIC\./);
    assertRunScopedJclContract(f.plan, 'preflight', jcl);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('run creation rejects uploaded metadata that differs from the metadata used to size its plan', async () => {
  const f = await fixture();
  try {
    assert.throws(() => createReconciliationOperation({
      runId: f.operation.runId,
      idempotencyKey: 'idempotency-key-0002',
      organizationId: f.operation.organizationId,
      organizationName: f.operation.organizationName,
      actorId: f.operation.actorId,
      profile: f.operation.profile,
      transaction: { ...f.operation.inputs.transaction, originalName: 'different-file.txt' },
      settlement: f.operation.inputs.settlement,
      plan: f.plan,
    }), /does not match the input metadata used to create this run's dataset allocation plan/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('changed fixed-width input evidence blocks before upload, allocation JCL or cleanup', async () => {
  const f = await fixture();
  try {
    const bad = Buffer.from(`${'X'.repeat(37)}\r\n`, 'ascii');
    const transactionPath=f.operation.inputs.transaction.stagedPath;
    assert.ok(transactionPath,'fixture transaction staged path is required');
    await fs.writeFile(transactionPath, bad);
    f.operation.inputs.transaction.size = bad.length;
    f.operation.inputs.transaction.sha256 = crypto.createHash('sha256').update(bad).digest('hex');
    f.operation.plan = buildRunExecutionPlan(f.plan.runId, f.plan.config, f.plan.token, {
      transaction: { originalName: f.operation.inputs.transaction.originalName, size: bad.length, recordCount: 1, valid: true },
      settlement: f.plan.inputs.settlement,
    });

    const result = await f.run();
    assert.equal(result.status, 'FAILED');
    assert.equal(result.failure?.category, 'INPUT_RECORD_CONTRACT_INVALID');
    assert.equal(f.submitted.length, 0);
    assert.equal(f.deleted.length, 0);
    assert.equal(f.remoteTouches.length, 0);
    assert.equal(f.readinessChecks, 0);
    assert.ok(result.datasets.every((dataset) => dataset.state === 'PLANNED'));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('missing staged input evidence blocks before allocation or upload', async () => {
  const f = await fixture();
  try {
    const settlementPath=f.operation.inputs.settlement.stagedPath;
    assert.ok(settlementPath,'fixture settlement staged path is required');
    await fs.unlink(settlementPath);
    const result = await f.run();
    assert.equal(result.status, 'FAILED');
    assert.equal(result.stage, 'INPUT_VALIDATION');
    assert.equal(result.failure?.category, 'STAGED_INPUT_UNAVAILABLE');
    assert.match(result.failure?.message ?? '', /ENOENT/);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.deleted.length, 0);
    assert.equal(f.remoteTouches.length, 0);
    assert.equal(f.readinessChecks, 0);
    assert.ok(result.datasets.every((dataset) => dataset.state === 'PLANNED'));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('run dataset collision stops before allocation and preserves the collision-check stage', async () => {
  const f = await fixture({ collision: true });
  try {
    const result = await f.run();
    assert.equal(result.status, 'FAILED');
    assert.equal(result.stage, 'DATASET_COLLISION_CHECK');
    assert.equal(result.failure?.category, 'DATASET_COLLISION');
    assert.equal(f.submitted.length, 0);
    assert.equal(f.deleted.length, 0);
    assert.ok(result.datasets.every((dataset) => dataset.state === 'PLANNED'));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
