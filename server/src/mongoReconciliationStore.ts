import mongoose from 'mongoose';
import { AuditEvent, Run, Upload } from './models.js';
import { logStructured, sanitizeText } from './observability.js';
import type { ReconciliationOperation, ReconciliationStore } from './reconciliationOrchestrator.js';

type LeanRun = {
  runId: string; idempotencyKey: string; organization: unknown; organizationName: string; actorId?: string;
  profile: ReconciliationOperation['profile']; status: ReconciliationOperation['status']; stage?: string;
  createdAt: Date; updatedAt: Date; completedAt?: Date;
  inputs?: { transaction?: Omit<ReconciliationOperation['inputs']['transaction'], 'stagedPath'>; settlement?: Omit<ReconciliationOperation['inputs']['settlement'], 'stagedPath'> };
  plan?: unknown; datasetManifest?: ReconciliationOperation['datasets']; stateTransitions?: ReconciliationOperation['transitions'];
  stepResults?: ReconciliationOperation['jobs']; stageResults?: Record<string, unknown>; summary?: ReconciliationOperation['summary'];
  outputReferences?: ReconciliationOperation['outputReferences']; diagnostics?: string[]; errorCode?: string; cleanupStatus?: ReconciliationOperation['cleanup'];
};

/** Persists the orchestration's state in the existing Run collection. Input paths
 * are rehydrated from the short-lived Upload documents, never copied into runs. */
export class MongoReconciliationStore implements ReconciliationStore {
  async createIfAbsent(operation: ReconciliationOperation): Promise<boolean> {
    try {
      await Run.create({
        runId: operation.runId, idempotencyKey: operation.idempotencyKey,
        organization: new mongoose.Types.ObjectId(operation.organizationId), organizationName: operation.organizationName, actorId: operation.actorId,
        status: operation.status, profile: operation.profile,
        inputs: { transaction: withoutPath(operation.inputs.transaction), settlement: withoutPath(operation.inputs.settlement) },
        plan: operation.plan, datasetManifest: operation.datasets, stateTransitions: operation.transitions,
        stepResults: operation.jobs, diagnostics: operation.diagnostics, outputReferences: operation.outputReferences,
        cleanupStatus: operation.cleanup, summary: operation.summary ?? {},
      });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  async save(operation: ReconciliationOperation): Promise<void> {
    const latest = operation.transitions.at(-1);
    const transitionId = latest ? `${latest.at.toISOString()}|${latest.status}|${latest.stage}` : undefined;
    const update = await Run.updateOne({ runId: operation.runId, idempotencyKey: operation.idempotencyKey }, { $set: {
      status: operation.status, stage: operation.stage, actorId: operation.actorId,
      plan: operation.plan, datasetManifest: operation.datasets, stateTransitions: operation.transitions,
      stepResults: operation.jobs, diagnostics: operation.diagnostics, outputReferences: operation.outputReferences,
      cleanupStatus: operation.cleanup, summary: operation.summary ?? {},
      jobId: operation.jobs.at(-1)?.jobId, jobStatus: operation.jobs.at(-1)?.status,
      returnCode: operation.jobs.at(-1)?.returnCode ?? undefined,
      completedAt: operation.completedAt,
      errorCode: operation.failure?.category,
      stageResults: operation.failure ? { ...operation.stageResults, failure: operation.failure } : operation.stageResults,
      ...(latest ? { updatedAt: latest.at } : {}),
    } });
    if (!update.matchedCount) throw new Error('Persisted run ownership changed; refusing to write orchestration state.');
    if (latest && transitionId) {
      const auditFilter = { runId: operation.runId, idempotencyKey: operation.idempotencyKey, lastAuditedTransitionId: { $ne: transitionId } };
      const claimed = await Run.updateOne(auditFilter, { $set: { lastAuditedTransitionId: transitionId } });
      if (claimed.modifiedCount) {
        try {
          await AuditEvent.create({ timestamp: latest.at, requestId: operation.operationId, actorId: operation.actorId, eventType: 'RECONCILIATION_STAGE', outcome: latest.status, resourceReference: operation.runId, durationMs: 0, errorCategory: operation.failure?.category, errorMessage: operation.failure?.message ? sanitizeText(operation.failure.message, 180) : undefined, action: 'RECONCILIATION_STAGE', runId: operation.runId, organizationId: operation.organizationId, actor: operation.actorId, details: { stage: sanitizeText(latest.stage, 80), status: latest.status } });
        } catch (error) {
          logStructured('error', { event: 'reconciliation.audit_persistence_failed', operationId: operation.operationId, stage: sanitizeText(latest.stage, 80), errorName: sanitizeText((error as Error)?.name ?? 'AuditError', 60) });
          throw error;
        }
      }
    }
  }

  async get(runId: string): Promise<ReconciliationOperation | undefined> {
    const run = await Run.findOne({ runId }).lean().exec() as unknown as LeanRun | null;
    if (!run) return undefined;
    const [transaction, settlement] = await Promise.all([
      Upload.findOne({ uploadId: run.inputs?.transaction?.uploadId }).lean().exec(),
      Upload.findOne({ uploadId: run.inputs?.settlement?.uploadId }).lean().exec(),
    ]);
    const runInputs = run.inputs;
    if (!transaction || !settlement || !runInputs?.transaction || !runInputs.settlement) return undefined;
    const transactionDoc = transaction as unknown as { stagedPath: string };
    const settlementDoc = settlement as unknown as { stagedPath: string };
    const planContainer = run.plan as { plan?: unknown } | undefined;
    const plan = (planContainer?.plan ?? run.plan) as ReconciliationOperation['plan'];
    return {
      runId: run.runId, operationId: run.runId, idempotencyKey: run.idempotencyKey,
      organizationId: String(run.organization), organizationName: run.organizationName, actorId: run.actorId ?? 'unknown', profile: run.profile,
      status: run.status, stage: run.stage ?? run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.completedAt,
      inputs: { transaction: { ...runInputs.transaction, stagedPath: transactionDoc.stagedPath }, settlement: { ...runInputs.settlement, stagedPath: settlementDoc.stagedPath } },
      plan, datasets: run.datasetManifest ?? [], transitions: run.stateTransitions ?? [], jobs: run.stepResults ?? [],
      stageResults: run.stageResults ?? {}, summary: run.summary, outputReferences: run.outputReferences ?? [], diagnostics: run.diagnostics ?? [],
      ...(run.errorCode ? { failure: { stage: run.stage ?? run.status, category: run.errorCode, message: run.diagnostics?.at(-1) ?? 'Persisted operation requires investigation.' } } : {}),
      cleanup: run.cleanupStatus ?? { status: 'NOT_STARTED', failedDatasets: [] },
    };
  }
}

function withoutPath(input: ReconciliationOperation['inputs']['transaction']) {
  return { uploadId: input.uploadId, originalName: input.originalName, size: input.size, sha256: input.sha256, recordCount: input.recordCount, valid: input.valid };
}
