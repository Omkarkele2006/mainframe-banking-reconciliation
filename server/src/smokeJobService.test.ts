import assert from 'node:assert/strict';
import test from 'node:test';
import { createNoopSmokeJcl, pollNoopSmokeJob, refreshNoopSmokeJob, startNoopSmokeJob, validateNoopSmokeJcl, type SmokeJobDependencies, type SmokeJobOperation, type SmokeJobStore } from './smokeJobService.js';

class MemoryStore implements SmokeJobStore {
  records = new Map<string, SmokeJobOperation>();
  active = new Set<string>();
  async findByIdempotency(actorId: string, key: string) { return [...this.records.values()].find(item => item.actorId === actorId && item.idempotencyKey === key); }
  async create(operation: SmokeJobOperation) {
    if (this.active.has(operation.actorId)) throw new Error('active lock');
    this.active.add(operation.actorId); this.records.set(operation.operationId, { ...operation });
  }
  async save(operation: SmokeJobOperation) {
    this.records.set(operation.operationId, { ...operation });
    if (operation.state === 'COMPLETED' || operation.state === 'FAILED') this.active.delete(operation.actorId);
  }
  async getForActor(operationId: string, actorId: string) { const found = this.records.get(operationId); return found?.actorId === actorId ? { ...found } : undefined; }
  async listForActor(actorId: string) { return [...this.records.values()].filter(item => item.actorId === actorId).map(item => ({ ...item })); }
}

const baseDependencies = (store = new MemoryStore(), overrides: Partial<SmokeJobDependencies> = {}) => {
  const calls = { submissions: 0, statuses: 0, spools: 0 };
  const deps: SmokeJobDependencies = {
    store, stagingRoot: 'unused-by-mock-adapter', enabled: true, jobClass: '7',
    readiness: async () => ({ connectionStatus: 'VERIFIED', message: 'Connection verified.' }),
    remote: {
      async submitJcl() { calls.submissions += 1; return { jobId: 'JOB04971' }; },
      async jobStatus(jobId) { calls.statuses += 1; return { jobId, status: 'OUTPUT', returnCode: 0, conditionCode: 'CC 0000' }; },
      async jobSpool() { calls.spools += 1; return 'IEFBR14 completed'; },
    },
    makeJobName: () => 'LSA1B2C3', sleep: async () => undefined,
    ...overrides,
  };
  return { deps, calls, store };
};

test('NOOP_SMOKE template uses the configured class and contains only a JOB card and IEFBR14 EXEC', () => {
  const jcl = createNoopSmokeJcl('LSA1B2C3', '7');
  assert.equal(jcl, '//LSA1B2C3 JOB ,MSGLEVEL=(2,0),CLASS=7\n//SMOKE    EXEC PGM=IEFBR14\n');
  assert.doesNotMatch(jcl, /\bDD\b|\bDSN\s*=|ZXP\.PUBLIC|Z73968\.BANK/i);
  assert.throws(() => createNoopSmokeJcl('BAD NAME', '7'), /job name/);
  assert.throws(() => createNoopSmokeJcl('LSA1B2C3', '7;'), /job-class/);
  assert.throws(() => validateNoopSmokeJcl(`${jcl}//SYSIN DD *\n`, 'LSA1B2C3', '7'), /approved no-DD template/);
});

test('disabled gate and missing profile readiness prevent submission', async () => {
  const disabled = baseDependencies(undefined, { enabled: false });
  await assert.rejects(() => startNoopSmokeJob('operator', 'idempotency-key-0001', disabled.deps), (error: unknown) => (error as {code?:string}).code === 'JOB_SUBMISSION_DISABLED');
  assert.equal(disabled.calls.submissions, 0);
  const noReady = baseDependencies(undefined, { readiness: async () => ({ connectionStatus: 'FAILED', message: 'Local profile check failed.' }) });
  const result = await startNoopSmokeJob('operator', 'idempotency-key-0002', noReady.deps);
  assert.equal(result.operation.state, 'FAILED');
  assert.equal(noReady.calls.submissions, 0);
});

test('persisted SUBMITTING state precedes submission and only the returned JES ID is stored', async () => {
  const setup = baseDependencies();
  setup.deps.remote.submitJcl = async () => {
    setup.calls.submissions += 1;
    const operation = [...setup.store.records.values()][0];
    assert.equal(operation?.state, 'SUBMITTING');
    assert.equal(operation?.jobId, undefined);
    return { jobId: 'JOB04971' };
  };
  const result = await startNoopSmokeJob('operator', 'idempotency-key-0003', setup.deps);
  assert.equal(result.operation.state, 'SUBMITTED');
  assert.equal(result.operation.jobId, 'JOB04971');
  assert.ok(result.operation.submittedAt);
});

test('ambiguous submit timeout is durable and idempotent retries do not resubmit', async () => {
  const setup = baseDependencies();
  setup.deps.remote.submitJcl = async () => { setup.calls.submissions += 1; throw Object.assign(new Error('process timeout; secret=hidden'), { code: 'TIMEOUT' }); };
  const first = await startNoopSmokeJob('operator', 'idempotency-key-0004', setup.deps);
  const replay = await startNoopSmokeJob('operator', 'idempotency-key-0004', setup.deps);
  assert.equal(first.operation.state, 'SUBMISSION_UNCERTAIN');
  assert.equal(first.operation.jobId, undefined);
  assert.equal(first.operation.errorCategory, 'TIMEOUT');
  assert.doesNotMatch(first.operation.errorMessage ?? '', /hidden/);
  assert.equal(replay.replayed, true);
  assert.equal(setup.calls.submissions, 1);
});

test('an unresolved operation prevents a second submission with a different request key', async () => {
  const setup = baseDependencies();
  setup.deps.remote.submitJcl = async () => { setup.calls.submissions += 1; throw Object.assign(new Error('request timed out'), { code: 'TIMEOUT' }); };
  const first = await startNoopSmokeJob('operator', 'idempotency-key-0010', setup.deps);
  assert.equal(first.operation.state, 'SUBMISSION_UNCERTAIN');
  await assert.rejects(() => startNoopSmokeJob('operator', 'idempotency-key-0011', setup.deps), (error: unknown) => (error as {code?:string}).code === 'JOB_OPERATION_CONFLICT');
  assert.equal(setup.calls.submissions, 1);
});

test('terminal status and actual spool evidence are persisted; nonzero RC is not success', async () => {
  const setup = baseDependencies();
  const started = await startNoopSmokeJob('operator', 'idempotency-key-0005', setup.deps);
  const done = await refreshNoopSmokeJob(started.operation, setup.deps);
  assert.equal(done.state, 'COMPLETED');
  assert.equal(done.jobStatus, 'OUTPUT');
  assert.equal(done.returnCode, 0);
  assert.equal(done.spoolText, 'IEFBR14 completed');
  assert.ok(done.spoolRetrievedAt);
  assert.equal((await setup.store.getForActor(done.operationId, 'other-operator')), undefined);

  const failed = baseDependencies(undefined, { remote: { submitJcl: async () => ({ jobId: 'JOB04972' }), jobStatus: async jobId => ({ jobId, status: 'OUTPUT', returnCode: 8 }), jobSpool: async () => 'JES evidence: RC=8' } });
  const submitted = await startNoopSmokeJob('operator', 'idempotency-key-0006', failed.deps);
  assert.equal((await refreshNoopSmokeJob(submitted.operation, failed.deps)).state, 'FAILED');
});

test('missing or mismatched JES evidence remains unresolved rather than successful', async () => {
  const setup = baseDependencies();
  const started = await startNoopSmokeJob('operator', 'idempotency-key-0009', setup.deps);
  setup.deps.remote.jobStatus = async () => ({ jobId: 'JOB99999', status: 'OUTPUT', returnCode: 0 });
  const unresolved = await refreshNoopSmokeJob(started.operation, setup.deps);
  assert.equal(unresolved.state, 'UNRESOLVED');
  assert.equal(unresolved.errorCategory, 'JES_JOB_MISMATCH');
  assert.equal(unresolved.spoolText, undefined);

  setup.deps.remote.jobStatus = async jobId => ({ jobId, status: 'OUTPUT', returnCode: 0 });
  setup.deps.remote.jobSpool = async () => { throw Object.assign(new Error('spool absent'), { code: 'JES_SPOOL_MISSING' }); };
  const missingSpool = await refreshNoopSmokeJob(unresolved, setup.deps);
  assert.equal(missingSpool.state, 'UNRESOLVED');
  assert.equal(missingSpool.errorCategory, 'JES_SPOOL_MISSING');
  assert.equal(missingSpool.returnCode, 0);
});

test('bounded polling times out as unresolved and never repeats the submission', async () => {
  const setup = baseDependencies();
  setup.deps.remote.submitJcl = async () => { setup.calls.submissions += 1; return { jobId: 'JOB04973' }; };
  setup.deps.remote.jobStatus = async jobId => { setup.calls.statuses += 1; return { jobId, status: 'ACTIVE', returnCode: null }; };
  const started = await startNoopSmokeJob('operator', 'idempotency-key-0007', setup.deps);
  const unresolved = await pollNoopSmokeJob(started.operation, setup.deps, 2, 0);
  assert.equal(unresolved.state, 'UNRESOLVED');
  assert.equal(setup.calls.statuses, 2);
  assert.equal(setup.calls.submissions, 1);
});

test('smoke operations require a valid authenticated actor identifier', async () => {
  const setup = baseDependencies();
  await assert.rejects(() => startNoopSmokeJob('', 'idempotency-key-0008', setup.deps), (error: unknown) => (error as {code?:string}).code === 'ACTOR_INVALID');
  assert.equal(setup.calls.submissions, 0);
});
