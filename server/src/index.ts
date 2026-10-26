import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import { AuditEvent, DatasetOperation, DatasetOwnership, ExecutionPlan, JobEvidence, Organization, Report, Run, SmokeJobOperation as SmokeJobOperationModel, Upload, UploadVerification } from './models.js';
import { readiness } from './mainframe.js';
import { auditQuery, historyQuery, organizationInput, previewInput, runInput, uploadVerificationPreviewInput, uploadVerificationStartInput, validateFixedWidthFile } from './validation.js';
import { resolveZoweTimeoutMs, runZoweConnectionTest, testZoweProfile } from './zoweCli.js';
import { logStructured, requestObservability, sanitizeText } from './observability.js';
import { buildExecutionPlanPreview, createRunId, MAX_UPLOAD_BYTES } from './executionPlan.js';
import { authConfiguration, authConfigured, authSessionView, createOperatorSession, requireOperator, revokeOperatorSession, sessionCookie, sessionMiddleware, clearSessionCookie, verifyOperatorPassword, type AuthRequest } from './operatorAuth.js';
import { buildUploadVerificationPlan, executeUploadVerification, retryUploadVerificationCleanup, safeSmokeErrorMessage, safeUploadVerificationResponse, validateSmokeConfiguration, type SmokeInput, type UploadVerificationRecord } from './uploadVerification.js';
import { createZoweUploadAdapter } from './zoweUploadAdapter.js';
import { createZoweReconciliationAdapter } from './zoweReconciliationAdapter.js';
import { datasetAllowedForRead, resolveDatasetReadScopes } from './datasetAccess.js';
import { assertDatasetUploadableState, canonicalRecordsSha256, datasetAllowedForMutation, datasetMutationBlockers, jobSubmissionBlockers, decideDatasetRecovery, makeOwnedSequentialDataset, sameRecords, validateDatasetUpload, writeTransferCopy } from './datasetLifecycle.js';
import { pollNoopSmokeJob, refreshNoopSmokeJob, startNoopSmokeJob, type SmokeJobOperation, type SmokeJobStore } from './smokeJobService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(projectRoot, '.env') });
const app = express();
const port = Number(process.env.PORT ?? 4000);
const uploadRoot = path.resolve(projectRoot, process.env.UPLOAD_DIR ?? 'server/.uploads');
const maxBytes = Math.min(Number(process.env.MAX_UPLOAD_BYTES ?? MAX_UPLOAD_BYTES), MAX_UPLOAD_BYTES);
const configuredDatasetReadScopes=()=>resolveDatasetReadScopes(process.env);
const datasetAllowedByScope=(dataset:string,scope:string)=>datasetAllowedForRead(dataset,scope,process.env);
function safeZoweError(error:unknown){const code=sanitizeText((error as {code?:unknown})?.code??'ZOWE_ERROR',80);return {code,message:sanitizeText((error as Error)?.message??'The mainframe operation failed.',240)};}
type ExportRun = { runId:string; organizationName:string; status:string; profile:string; createdAt:Date; completedAt?:Date; inputs:{transaction?:{originalName?:string;recordCount?:number};settlement?:{originalName?:string;recordCount?:number}}; summary:Record<string,unknown>; jobId?:string; jobStatus?:string; returnCode?:number; eodDecision?:string; diagnostics?:string[]; errorCode?:string; stepResults?:Array<Record<string,unknown>>; datasetManifest?:Array<Record<string,unknown>>; outputReferences?:Array<Record<string,unknown>>; cleanupStatus?:Record<string,unknown> };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1 }, fileFilter: (_req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() === '.txt') });
app.disable('x-powered-by');
app.use(helmet());
app.use('/api', requestObservability({ audit: (record) => AuditEvent.create(record) }));
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((v) => v.trim());
app.use(cors({ origin: allowedOrigins, credentials: true, methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','X-CSRF-Token','Idempotency-Key'] }));
app.use(express.json({ limit: '32kb' }));
app.use('/api', sessionMiddleware);
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
const zosmfConnectionLimit = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many connection-test attempts. Wait 15 minutes and try again.' } });
const operatorLoginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Wait 15 minutes and try again.' } });
const uploadVerificationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 3, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many mainframe file-transfer tests. Wait 15 minutes and try again.' } });
const datasetMutationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many dataset mutation attempts. Wait 15 minutes and try again.' } });
const jobSubmissionLimit = rateLimit({ windowMs: 15 * 60_000, limit: 3, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many JES smoke-job submissions. Wait 15 minutes and try again.' } });
const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req,res).catch(next); };
const audit = (action: string, outcome: string, details: Record<string, unknown> = {}, runId?: string, organizationId?: string, req?: Request) => {
  const requestId = resRequestId(req);
  return AuditEvent.create({ timestamp: new Date(), requestId, actorId: sanitizeText((req as (Request & { actorId?: string }) | undefined)?.actorId ?? 'anonymous',120), eventType: sanitizeText(action, 80), outcome: sanitizeText(outcome, 40), resourceReference: runId ?? organizationId ?? 'api', durationMs: 0, action: sanitizeText(action, 100), runId, organizationId, details: sanitizeAuditDetails(details) });
};
function resRequestId(req?: Request) { return (req as (Request & { requestId?: string }) | undefined)?.requestId; }
function sanitizeAuditDetails(details: Record<string, unknown>) { const safe: Record<string, unknown> = {}; for (const [key,value] of Object.entries(details)) { if (/password|token|authorization|cookie|secret|jcl|spool|payload|body/i.test(key)) continue; if (typeof value === 'string') safe[sanitizeText(key,60)] = sanitizeText(value,200); else if (typeof value === 'number' || typeof value === 'boolean') safe[sanitizeText(key,60)] = value; } return safe; }
async function createDatasetOperation(data: Record<string, unknown>) { try { return await DatasetOperation.create(data); } catch (error) { if ((error as {code?:number}).code === 11000) return null; throw error; } }
function isOwnedSequentialAttributes(dataset: string, value: Record<string, unknown>): boolean { return typeof value.dsname === 'string' && value.dsname.toUpperCase() === dataset.toUpperCase() && typeof value.dsorg === 'string' && value.dsorg.toUpperCase() === 'PS' && typeof value.recfm === 'string' && value.recfm.toUpperCase() === 'FB' && Number(value.lrecl) === 38; }
function validObjectId(value: unknown): value is string { return typeof value === 'string' && mongoose.isValidObjectId(value); }
const smokeJobStore: SmokeJobStore = {
  async findByIdempotency(actorId,key) { return await SmokeJobOperationModel.findOne({actorId,idempotencyKey:key}).lean().exec() as unknown as SmokeJobOperation|undefined; },
  async create(operation) { await SmokeJobOperationModel.create(operation); },
  async save(operation) {
    const fields = Object.fromEntries(Object.entries(operation).filter(([key,value]) => key !== 'activeLock' && value !== undefined));
    const unset = ['COMPLETED','FAILED'].includes(operation.state) ? {activeLock:1} : {};
    const result = await SmokeJobOperationModel.updateOne({operationId:operation.operationId},{$set:fields,...(Object.keys(unset).length?{$unset:unset}:{})});
    if (result.matchedCount !== 1) throw new Error('Smoke-job operation persistence record is unavailable.');
  },
  async getForActor(operationId,actorId) { return await SmokeJobOperationModel.findOne({operationId,actorId}).lean().exec() as unknown as SmokeJobOperation|undefined; },
  async listForActor(actorId) { return await SmokeJobOperationModel.find({actorId}).select('-idempotencyKey -activeLock -spoolText').sort({createdAt:-1}).limit(100).lean().exec() as unknown as SmokeJobOperation[]; },
};
const smokePolls = new Set<string>();
function publicSmokeOperation(operation: SmokeJobOperation, includeSpool = true) {
  const safe = {operationId:operation.operationId,actorId:operation.actorId,template:operation.template,jobName:operation.jobName,state:operation.state,jobId:operation.jobId,jobStatus:operation.jobStatus,returnCode:operation.returnCode,conditionCode:operation.conditionCode,createdAt:operation.createdAt,submittedAt:operation.submittedAt,lastCheckedAt:operation.lastCheckedAt,completedAt:operation.completedAt,spoolTruncated:operation.spoolTruncated,spoolRetrievedAt:operation.spoolRetrievedAt,errorCategory:operation.errorCategory,errorMessage:operation.errorMessage,...(includeSpool&&operation.spoolText!==undefined?{spoolText:operation.spoolText}:{})};
  return safe;
}
function smokeJobDependencies() {
  return { store:smokeJobStore, remote:createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot}), stagingRoot:uploadRoot,
    enabled:process.env.MAINFRAME_JOB_SUBMISSION_ENABLED==='true', jobClass:process.env.MAINFRAME_JOB_CLASS??'',
    readiness:async()=>{ const result=await testZoweProfile({timeoutMs:resolveZoweTimeoutMs(process.env)}); return {connectionStatus:result.connectionStatus,message:result.message}; } };
}
function monitorSmokeOperation(operation: SmokeJobOperation) {
  if(!operation.jobId||smokePolls.has(operation.operationId))return;
  smokePolls.add(operation.operationId);
  void pollNoopSmokeJob(operation,smokeJobDependencies(),4,1500).then((updated)=>{
    logStructured(updated.state==='COMPLETED'?'info':updated.state==='FAILED'?'warn':'warn',{event:'jes.noop_smoke_poll_finished',operationId:updated.operationId,state:updated.state,jobId:updated.jobId,returnCode:updated.returnCode??null,errorCategory:updated.errorCategory});
  }).catch((error:unknown)=>logStructured('error',{event:'jes.noop_smoke_poll_failed',operationId:operation.operationId,errorCategory:safeZoweError(error).code})).finally(()=>smokePolls.delete(operation.operationId));
}
function scrubRunStoragePaths(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const run = value as Record<string, unknown>;
  const outputReferences = Array.isArray(run.outputReferences) ? run.outputReferences.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const publicReference = { ...(raw as Record<string, unknown>) };
    delete publicReference.localPath;
    return publicReference;
  }) : run.outputReferences;
  return { ...run, outputReferences };
}
async function cleanupStaging() {
  try {
    const entries=await fs.readdir(uploadRoot,{withFileTypes:true});
    for(const entry of entries){if(!entry.isFile()||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:txt|out|jcl)$/i.test(entry.name))continue;const fullPath=path.resolve(uploadRoot,entry.name);if(path.dirname(fullPath)!==uploadRoot)continue;const stat=await fs.stat(fullPath);const retention=entry.name.toLowerCase().endsWith('.out')?60*60*1000:24*60*60*1000;if(Date.now()-stat.mtimeMs>retention)await fs.unlink(fullPath);}
  } catch(error) { logStructured('warn',{event:'upload.staging_cleanup_failed',errorName:sanitizeText((error as Error).name??'Error',60)}); }
}
async function markInterruptedDatasetOperations() {
  const pending=await DatasetOperation.find({status:{$in:['PREPARED','RUNNING']}}).limit(1000);
  for(const operation of pending){
    if(operation.action==='RECOVER'){
      operation.status='FAILED';operation.errorCategory='RECOVERY_INTERRUPTED';operation.errorMessage='Read-only recovery was interrupted; no remote mutation was performed. Start a new recovery check.';await operation.save();
    }else{
      operation.status='UNCERTAIN';operation.errorCategory='PROCESS_INTERRUPTED';operation.errorMessage='The API stopped during a remote operation. Check actual remote state before another mutation.';await operation.save();
      if(operation.ownershipId)await DatasetOwnership.updateOne({_id:operation.ownershipId,lastOperationId:operation.operationId,state:{$in:['CREATING','UPLOADING','DELETING']}},{$set:{state:'UNCERTAIN',lastErrorCategory:'PROCESS_INTERRUPTED'}});
    }
    await AuditEvent.create({timestamp:new Date(),actorId:operation.actorId,eventType:'DATASET_OPERATION_INTERRUPTED',outcome:'ERROR',resourceReference:operation.dataset,errorCategory:'PROCESS_INTERRUPTED',errorMessage:'An operation was interrupted; no automatic retry was made.',action:'DATASET_OPERATION_INTERRUPTED',details:{operationId:operation.operationId}});
  }
}
async function markInterruptedSmokeSubmissions() {
  const prepared=await SmokeJobOperationModel.updateMany({state:'PREPARED'},{$set:{state:'FAILED',completedAt:new Date(),errorCategory:'PROCESS_INTERRUPTED',errorMessage:'The API stopped before the JES submission attempt began. No job was submitted.'},$unset:{activeLock:1}});
  const submitting=await SmokeJobOperationModel.updateMany({state:'SUBMITTING'},{$set:{state:'SUBMISSION_UNCERTAIN',errorCategory:'PROCESS_INTERRUPTED',errorMessage:'The API stopped during submission. Check JES manually before taking any further action; this operation will not be resubmitted.'}});
  if(prepared.modifiedCount)logStructured('warn',{event:'jes.smoke_preparation_recovered',count:prepared.modifiedCount,state:'FAILED'});
  if(submitting.modifiedCount)logStructured('warn',{event:'jes.smoke_submission_recovery',count:submitting.modifiedCount,state:'SUBMISSION_UNCERTAIN'});
}

app.get('/api/health', (_req,res) => res.json({ status:'ok', database: mongoose.connection.readyState === 1 ? 'connected':'disconnected', timestamp:new Date().toISOString() }));
app.get('/api/auth/session', (req,res) => res.json({ configured: authConfigured(), ...authSessionView(req as AuthRequest) }));
app.post('/api/auth/login', operatorLoginLimit, asyncRoute(async (req,res) => {
  const config = authConfiguration();
  if (!authConfigured(config)) return res.status(503).json({ code: 'OPERATOR_AUTH_NOT_CONFIGURED', message: 'Protected operations are unavailable until the server administrator configures an operator username and password hash.' });
  const origin = req.get('origin');
  if (!origin || !allowedOrigins.includes(origin)) return res.status(403).json({ code: 'ORIGIN_REJECTED', message: 'Sign-in requires an approved application origin.' });
  const body = req.body as { username?: unknown; password?: unknown };
  if (typeof body?.username !== 'string' || typeof body?.password !== 'string' || Object.keys(body).some((key) => !['username','password'].includes(key))) return res.status(400).json({ code: 'LOGIN_INPUT_INVALID', message: 'Provide the configured username and password.' });
  const usernameMatch = body.username === config.username;
  const passwordMatch = await verifyOperatorPassword(body.password, config);
  if (!usernameMatch || !passwordMatch) { await audit('OPERATOR_LOGIN','FAILED',{ errorCategory:'AUTHENTICATION' },undefined,undefined,req); return res.status(401).json({ code:'AUTHENTICATION_FAILED',message:'The operator credentials were not accepted.' }); }
  (req as AuthRequest).actorId=body.username;res.locals.actorId=body.username;
  const session = createOperatorSession(body.username, config);
  res.setHeader('Set-Cookie', sessionCookie(session.token, config));
  await audit('OPERATOR_LOGIN','SUCCESS',{},undefined,undefined,req);
  return res.json({ authenticated:true, actorId:body.username, csrfToken:session.csrfToken, expiresAt:session.expiresAt });
}));
app.post('/api/auth/logout', requireOperator, (req,res) => { revokeOperatorSession(req); res.setHeader('Set-Cookie',clearSessionCookie()); return res.json({ authenticated:false }); });
app.get('/api/readiness', (_req,res) => {
  const state = readiness();
  return res.json({
    ...state,
    connectionTestConfigured: true,
    connectionTest: 'NOT_TESTED',
    // A legacy one-job adapter must never make the UI or API claim that the
    // run-specific pipeline is available before its target contracts are validated.
    liveExecutionEnabled: false,
    reconciliationExecutionEnabled: false,
    reconciliationExecutionConfigured: false,
    reconciliationBlockers: [...state.reconciliationBlockers, 'The run-specific JCL, JES/spool, and output contracts have not been validated on z/OS; the production adapter remains unconfigured.'],
    message: 'Read-only Zowe checks are available. Run-specific processing code has offline mock coverage, but live reconciliation remains unavailable until generated JCL and output contracts are target-validated and the production adapter is explicitly configured.',
  });
});
app.post('/api/mainframe/connection-test', zosmfConnectionLimit, asyncRoute(async (req,res) => {
  const requestId=(req as Request&{requestId?:string}).requestId;
  logStructured('info',{event:'mainframe.connection_test',requestId,stage:'request_received'});
  const hasRawBody = (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) > 0) || req.headers['transfer-encoding'] !== undefined;
  if (hasRawBody || (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0)) return res.status(400).json({ code: 'UNEXPECTED_REQUEST_BODY', message: 'This read-only test uses the backend process local Zowe profile and accepts no credentials or request fields.' });
  const result = await runZoweConnectionTest({ timeoutMs: resolveZoweTimeoutMs(process.env), log: (level, stage, details = {}) => logStructured(level, { event: 'mainframe.connection_test', requestId, stage, ...details }) });
  const code = result.state === 'CLI_UNAVAILABLE' ? 'ZOWE_CLI_UNAVAILABLE' : result.errorCategory ? `ZOWE_${result.errorCategory}` : undefined;
  const status = result.state === 'DATASET_ACCESS_VERIFIED' ? 200 : result.state === 'CLI_UNAVAILABLE' ? 503 : result.errorCategory === 'AUTHENTICATION' ? 401 : result.datasetAccessStatus === 'DENIED' || result.errorCategory === 'AUTHORIZATION' ? 403 : result.errorCategory === 'TIMEOUT' ? 504 : 502;
  return res.status(status).json({ ...result, ...(code ? { code } : {}) });
}));
app.get('/api/mainframe/datasets/scopes', requireOperator, (_req,res) => {
  const scopes=configuredDatasetReadScopes();
  const mutationBlockers=datasetMutationBlockers(process.env);
  return res.json({scopes,available:scopes.length>0,mutationsEnabled:mutationBlockers.length===0,mutationBlockers,recoveryEnabled:mutationBlockers.length===0,jobSubmissionEnabled:false,unavailableReason:scopes.length?'Read-only browsing is available in configured scopes. Dataset mutations use a separate server-configured personal namespace and persisted ownership.':'The administrator has not configured MAINFRAME_HLQ and MAINFRAME_DATASET_READ_SCOPES.'});
});
app.get('/api/mainframe/datasets', requireOperator, asyncRoute(async(req,res)=>{
  const scope=typeof req.query.scope==='string'?req.query.scope.trim().toUpperCase():'';
  if(!configuredDatasetReadScopes().includes(scope))return res.status(configuredDatasetReadScopes().length?403:503).json({code:configuredDatasetReadScopes().length?'DATASET_SCOPE_DENIED':'DATASET_SCOPES_NOT_CONFIGURED',message:configuredDatasetReadScopes().length?'Select a server-approved read scope.':'Dataset browsing is unavailable until the administrator configures an approved read scope.'});
  const started=Date.now();
  try{const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});const datasets=await adapter.listDatasets(scope);await audit('DATASET_LISTED','SUCCESS',{scope,count:datasets.length},undefined,undefined,req);return res.json({scope,datasets,source:'z/OSMF RFJ'});}
  catch(error){const safe=safeZoweError(error);await audit('DATASET_LISTED','FAILED',{scope,errorCategory:safe.code,errorMessage:safe.message},undefined,undefined,req);return res.status(safe.code==='AUTHORIZATION'?403:safe.code==='TIMEOUT'?504:502).json({code:safe.code,message:safe.message});}
  finally{logStructured('info',{event:'dataset.list_completed',requestId:resRequestId(req),durationMs:Date.now()-started,outcome:res.statusCode});}
}));
app.get('/api/mainframe/datasets/:dataset/attributes', requireOperator, asyncRoute(async(req,res)=>{
  const dataset=String(req.params.dataset).toUpperCase();const scope=typeof req.query.scope==='string'?req.query.scope.trim().toUpperCase():'';
  if(!datasetAllowedByScope(dataset,scope))return res.status(403).json({code:'DATASET_SCOPE_DENIED',message:'The requested dataset is outside the selected server-approved read scope.'});
  try{const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});const attributes=await adapter.datasetAttributes(dataset);await audit('DATASET_ATTRIBUTES_READ','SUCCESS',{dataset},undefined,undefined,req);return res.json({dataset,attributes});}
  catch(error){const safe=safeZoweError(error);await audit('DATASET_ATTRIBUTES_READ','FAILED',{dataset,errorCategory:safe.code,errorMessage:safe.message},undefined,undefined,req);return res.status(safe.code==='AUTHORIZATION'?403:safe.code==='TIMEOUT'?504:502).json({code:safe.code,message:safe.message});}
}));
app.get('/api/mainframe/datasets/:dataset/content', requireOperator, asyncRoute(async(req,res)=>{
  const dataset=String(req.params.dataset).toUpperCase();const scope=typeof req.query.scope==='string'?req.query.scope.trim().toUpperCase():'';
  if(!datasetAllowedByScope(dataset,scope))return res.status(403).json({code:'DATASET_SCOPE_DENIED',message:'The requested dataset is outside the selected server-approved read scope.'});
  const localPath=path.join(uploadRoot,`${crypto.randomUUID()}.out`);
  let streamingDownload=false;
  try{
    const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});const attributes=await adapter.datasetAttributes(dataset);
    if(attributes.dsorg!=='PS'||attributes.recfm!=='FB'||![38,120].includes(Number(attributes.lrecl)))return res.status(415).json({code:'DATASET_CONTENT_UNSUPPORTED',message:'Content preview is supported only for PS/FB datasets with LRECL 38 or 120.'});
    await adapter.downloadDataset(dataset,localPath);const stat=await fs.stat(localPath);if(stat.size>2*1024*1024)return res.status(413).json({code:'DATASET_CONTENT_TOO_LARGE',message:'Dataset exceeds the 2 MiB preview limit.'});
    const text=(await fs.readFile(localPath)).toString('utf8');const lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');const records=lines.at(-1)===''?lines.slice(0,-1):lines;if(records.some((record)=>Buffer.byteLength(record,'utf8')!==Number(attributes.lrecl)))return res.status(422).json({code:'DATASET_CONTENT_INVALID',message:'Downloaded content did not match the reported fixed-block record length.'});
    await audit('DATASET_CONTENT_READ','SUCCESS',{dataset,bytes:stat.size,records:records.length,download:req.query.download==='true'},undefined,undefined,req);
    if(req.query.download==='true') { streamingDownload=true;res.download(localPath,`${dataset.replaceAll('.','_')}.txt`,(error)=>{if(error&&!res.headersSent)res.status(500).end();void fs.unlink(localPath).catch(()=>undefined);}); return; }
    return res.json({dataset,recordFormat:attributes.recfm,lrecl:attributes.lrecl,records:records.slice(0,200),recordCount:records.length,truncated:records.length>200,bytes:stat.size});
  }catch(error){const safe=safeZoweError(error);await audit('DATASET_CONTENT_READ','FAILED',{dataset,errorCategory:safe.code,errorMessage:safe.message},undefined,undefined,req);return res.status(safe.code==='AUTHORIZATION'?403:safe.code==='TIMEOUT'?504:502).json({code:safe.code,message:safe.message});}
  finally{if(!streamingDownload)await fs.unlink(localPath).catch(()=>undefined);}
}));
app.get('/api/mainframe/owned-datasets', requireOperator, asyncRoute(async(req,res)=>{
  const actorId=(req as AuthRequest).actorId!;
  const items=await DatasetOwnership.find({ownerActorId:actorId}).select('dataset state attributes allocation createdByOperationId lastOperationId lastErrorCategory createdAtRemote deletedAtRemote createdAt updatedAt').sort({createdAt:-1}).limit(100).lean();
  return res.json({items,mutationBlockers:datasetMutationBlockers(process.env)});
}));
app.get('/api/mainframe/dataset-operations', requireOperator, asyncRoute(async(req,res)=>{
  const actorId=(req as AuthRequest).actorId!;
  const items=await DatasetOperation.find({actorId}).select('operationId action dataset status evidence errorCategory errorMessage createdAt updatedAt').sort({createdAt:-1}).limit(50).lean();
  await audit('DATASET_OPERATION_HISTORY_VIEWED','SUCCESS',{count:items.length},undefined,undefined,req);
  return res.json({items});
}));
app.get('/api/mainframe/jobs/submission-readiness', requireOperator, asyncRoute(async(req,res)=>{
  const blockers=jobSubmissionBlockers(process.env);
  await audit('JOB_SUBMISSION_READINESS_VIEWED',blockers.length?'BLOCKED':'SUCCESS',{blockerCount:blockers.length},undefined,undefined,req);
  return res.json({enabled:blockers.length===0,approvedTemplates:['NOOP_SMOKE'],blockers,message:blockers.length?'The approved NOOP_SMOKE job is unavailable until the dedicated submission gate and job class are configured.':'Only the server-owned NOOP_SMOKE template is available. Reconciliation remains NOT_CONFIGURED.'});
}));
app.post('/api/mainframe/jobs/noop-smoke', requireOperator, jobSubmissionLimit, asyncRoute(async(req,res)=>{
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length!==0)return res.status(400).json({code:'SMOKE_JOB_BODY_REJECTED',message:'This action accepts no browser-supplied JCL, command, dataset, path, or job parameters.'});
  const blockers=jobSubmissionBlockers(process.env);if(blockers.length){await audit('NOOP_SMOKE_SUBMISSION','BLOCKED',{blockerCount:blockers.length},undefined,undefined,req);return res.status(503).json({code:'JOB_SUBMISSION_DISABLED',message:'The server-approved smoke job is disabled by configuration.',blockers});}
  const actorId=(req as AuthRequest).actorId!;const idempotencyKey=req.get('Idempotency-Key')??'';
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))return res.status(400).json({code:'IDEMPOTENCY_KEY_REQUIRED',message:'A unique Idempotency-Key is required.'});
  const dependencies=smokeJobDependencies();
  try{
    const result=await startNoopSmokeJob(actorId,idempotencyKey,dependencies);
    const operation=result.operation;
    await audit('NOOP_SMOKE_SUBMISSION',operation.state==='SUBMITTED'?'SUCCESS':operation.state==='SUBMISSION_UNCERTAIN'?'ERROR':operation.state==='FAILED'?'FAILED':'REPLAYED',{operationId:operation.operationId,template:operation.template,jobName:operation.jobName,jobId:operation.jobId,state:operation.state,errorCategory:operation.errorCategory},operation.operationId,undefined,req);
    if(operation.jobId&&!['COMPLETED','FAILED'].includes(operation.state))monitorSmokeOperation(operation);
    const status=operation.state==='FAILED'?502:operation.state==='SUBMISSION_UNCERTAIN'||operation.state==='UNRESOLVED'?202:result.replayed?200:202;
    return res.status(status).json({...publicSmokeOperation(operation),...(operation.errorMessage?{message:operation.errorMessage}:{})});
  }catch(error){const safe=safeZoweError(error);const status=safe.code==='JOB_SUBMISSION_DISABLED'||safe.code==='JOB_CLASS_INVALID'?503:safe.code==='JOB_OPERATION_CONFLICT'?409:400;await audit('NOOP_SMOKE_SUBMISSION','FAILED',{errorCategory:safe.code,errorMessage:safe.message},undefined,undefined,req);return res.status(status).json({code:safe.code,message:safe.message});}
}));
app.get('/api/mainframe/jobs/operations', requireOperator, asyncRoute(async(req,res)=>{
  const actorId=(req as AuthRequest).actorId!;const items=await smokeJobStore.listForActor(actorId);await audit('NOOP_SMOKE_HISTORY_VIEWED','SUCCESS',{count:items.length},undefined,undefined,req);return res.json({items:items.map((item)=>publicSmokeOperation(item,false))});
}));
app.get('/api/mainframe/jobs/operations/:operationId', requireOperator, asyncRoute(async(req,res)=>{
  const actorId=(req as AuthRequest).actorId!;const operationId=String(req.params.operationId);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId))return res.status(404).json({code:'JOB_OPERATION_NOT_FOUND',message:'Smoke-job operation not found.'});
  let operation=await smokeJobStore.getForActor(operationId,actorId);if(!operation)return res.status(404).json({code:'JOB_OPERATION_NOT_FOUND',message:'Smoke-job operation not found.'});
  if(operation.jobId&&!['COMPLETED','FAILED'].includes(operation.state)){operation=await refreshNoopSmokeJob(operation,smokeJobDependencies());if(operation.state==='RUNNING')monitorSmokeOperation(operation);}
  await audit('NOOP_SMOKE_EVIDENCE_VIEWED',operation.errorCategory?'ERROR':'SUCCESS',{operationId:operation.operationId,jobId:operation.jobId,state:operation.state,returnCode:operation.returnCode,errorCategory:operation.errorCategory},operation.operationId,undefined,req);
  return res.json(publicSmokeOperation(operation));
}));
app.post('/api/mainframe/owned-datasets', requireOperator, datasetMutationLimit, asyncRoute(async(req,res)=>{
  const actorId=(req as AuthRequest).actorId!; const idempotencyKey=req.get('Idempotency-Key')??'';
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))return res.status(400).json({code:'IDEMPOTENCY_KEY_REQUIRED',message:'A unique Idempotency-Key is required.'});
  const body=req.body as {primaryTracks?:unknown;secondaryTracks?:unknown};
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some((key)=>!['primaryTracks','secondaryTracks'].includes(key))||!Number.isInteger(body.primaryTracks)||Number(body.primaryTracks)<1||Number(body.primaryTracks)>500||!Number.isInteger(body.secondaryTracks)||Number(body.secondaryTracks)<0||Number(body.secondaryTracks)>500)return res.status(400).json({code:'DATASET_ALLOCATION_INVALID',message:'Provide primary tracks from 1–500 and secondary tracks from 0–500. Dataset name and PS/FB/LRECL=38 attributes are fixed by the server.'});
  const primaryTracks=Number(body.primaryTracks);const secondaryTracks=Number(body.secondaryTracks);
  const blockers=datasetMutationBlockers(process.env);if(blockers.length)return res.status(503).json({code:'DATASET_MUTATIONS_DISABLED',message:'Sequential dataset mutations are disabled by server configuration.',blockers});
  const prior=await DatasetOperation.findOne({actorId,idempotencyKey}).lean();if(prior)return res.status(409).json({code:'IDEMPOTENCY_KEY_REUSED',message:'This operation key was already used. Inspect its persisted result; no remote action was repeated.',operation:prior});
  const operationId=crypto.randomUUID();const entropy=crypto.randomBytes(8).readBigUInt64BE()% (36n**7n);const qualifier=`U${entropy.toString(36).toUpperCase().padStart(7,'0')}`;const dataset=makeOwnedSequentialDataset(qualifier);
  if(!datasetAllowedForMutation(dataset,process.env))return res.status(503).json({code:'DATASET_MUTATION_SCOPE_INVALID',message:'The generated dataset is outside the configured personal project mutation scope.'});
  const operation=await createDatasetOperation({operationId,idempotencyKey,actorId,action:'CREATE',dataset,status:'PREPARED',evidence:{format:'PS/FB/LRECL=38',primaryTracks,secondaryTracks}});if(!operation)return res.status(409).json({code:'IDEMPOTENCY_KEY_REUSED',message:'This operation key was already used; no remote action was started.'});
  const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});let ownership:InstanceType<typeof DatasetOwnership>|undefined;
  try{
    const connection=await runZoweConnectionTest({timeoutMs:resolveZoweTimeoutMs(process.env)});if(connection.state!=='DATASET_ACCESS_VERIFIED')throw Object.assign(new Error(connection.message),{code:'MAINFRAME_NOT_READY'});
    try{await adapter.datasetAttributes(dataset);throw Object.assign(new Error('The generated dataset name already exists; no overwrite was attempted.'),{code:'DATASET_COLLISION'});}catch(error){if((error as {code?:string}).code!=='DATASET_NOT_FOUND')throw error;}
    ownership=await DatasetOwnership.create({dataset,ownerActorId:actorId,createdByOperationId:operationId,state:'CREATING',attributes:{dsorg:'PS',recfm:'FB',lrecl:38},allocation:{unit:'TRK',primary:primaryTracks,secondary:secondaryTracks},lastOperationId:operationId});
    operation.status='RUNNING';operation.ownershipId=ownership._id;await operation.save();
    await adapter.createSequential(dataset,primaryTracks,secondaryTracks);operation.evidence={...operation.evidence,allocationCommandSucceeded:true};await operation.save();
    const attributes=await adapter.datasetAttributes(dataset);
    if(!isOwnedSequentialAttributes(dataset,attributes))throw Object.assign(new Error('Created dataset did not verify as the requested PS/FB/LRECL=38 resource.'),{code:'DATASET_ATTRIBUTES_MISMATCH'});
    ownership.state='CREATED';ownership.attributes=attributes;ownership.createdAtRemote=new Date();await ownership.save();operation.status='SUCCEEDED';operation.evidence={...operation.evidence,attributes,verifiedAt:new Date()};await operation.save();
    await audit('DATASET_CREATED','SUCCESS',{dataset,ownershipId:String(ownership._id)},operationId,undefined,req);return res.status(201).json({operationId,ownershipId:ownership._id,dataset,state:ownership.state,attributes,allocation:ownership.allocation});
  }catch(error){const safe=safeZoweError(error);if(ownership){ownership.state='UNCERTAIN';ownership.lastErrorCategory=safe.code;await ownership.save();}operation.status=ownership?'UNCERTAIN':'FAILED';operation.errorCategory=safe.code;operation.errorMessage=safe.message;await operation.save();await audit('DATASET_CREATED','FAILED',{dataset,errorCategory:safe.code,errorMessage:safe.message},operationId,undefined,req);return res.status(safe.code==='AUTHORIZATION'?403:safe.code==='TIMEOUT'?504:safe.code==='DATASET_COLLISION'?409:502).json({code:safe.code,message:safe.message,operationId,dataset,state:ownership?.state??'NOT_CREATED'});}
}));
app.post('/api/mainframe/owned-datasets/:ownershipId/content', requireOperator, datasetMutationLimit, upload.single('file'), asyncRoute(async(req,res)=>{
  const actorId=(req as AuthRequest).actorId!;const idempotencyKey=req.get('Idempotency-Key')??'';
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))return res.status(400).json({code:'IDEMPOTENCY_KEY_REQUIRED',message:'A unique Idempotency-Key is required.'});
  const blockers=datasetMutationBlockers(process.env);if(blockers.length)return res.status(503).json({code:'DATASET_MUTATIONS_DISABLED',message:'Dataset upload and replacement are disabled by server configuration.',blockers});
  if(!req.file)return res.status(400).json({code:'FILE_REQUIRED',message:'Select one .txt file containing 38-byte records.'});
  let parsed:{records:string[];recordCount:number};try{parsed=validateDatasetUpload(req.file.buffer);}catch(error){return res.status(422).json({code:'FILE_CONTRACT_INVALID',message:sanitizeText((error as Error).message,200)});}
  if(!validObjectId(req.params.ownershipId))return res.status(404).json({code:'OWNED_DATASET_NOT_FOUND',message:'No app-owned dataset was found for this operator.'});const ownership=await DatasetOwnership.findOne({_id:req.params.ownershipId,ownerActorId:actorId});if(!ownership||!datasetAllowedForMutation(ownership.dataset,process.env))return res.status(404).json({code:'OWNED_DATASET_NOT_FOUND',message:'No app-owned dataset was found for this operator.'});
  try{assertDatasetUploadableState(ownership.state);}catch(error){return res.status(409).json({code:'OWNED_DATASET_NOT_READY',message:sanitizeText((error as Error).message,200)});}if(ownership.state==='ACTIVE'&&req.body?.confirmDataset!==ownership.dataset)return res.status(400).json({code:'EXACT_CONFIRMATION_REQUIRED',message:'Replacing dataset contents requires exact-name confirmation.'});if(ownership.state==='ACTIVE'&&typeof req.body?.confirmDataset==='string'&&req.body.confirmDataset.trim().toUpperCase()!==ownership.dataset)return res.status(400).json({code:'EXACT_CONFIRMATION_MISMATCH',message:'Replace confirmation must exactly match the owned dataset name.'});
  const prior=await DatasetOperation.findOne({actorId,idempotencyKey}).lean();if(prior)return res.status(409).json({code:'IDEMPOTENCY_KEY_REUSED',message:'This operation key was already used; no upload was repeated.',operation:prior});
  const action=ownership.state==='ACTIVE'?'REPLACE':'UPLOAD';const operationId=crypto.randomUUID();const operation=await createDatasetOperation({operationId,idempotencyKey,actorId,action,dataset:ownership.dataset,ownershipId:ownership._id,status:'PREPARED',evidence:{inputBytes:req.file.size,recordCount:parsed.recordCount,expectedContentSha256:canonicalRecordsSha256(parsed.records),filename:sanitizeText(path.basename(req.file.originalname),120)}});if(!operation)return res.status(409).json({code:'IDEMPOTENCY_KEY_REUSED',message:'This operation key was already used; no upload was started.'});
  const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});const uploadAdapter=createZoweUploadAdapter({timeoutMs:resolveZoweTimeoutMs(process.env)});const downloadPath=path.join(uploadRoot,`${crypto.randomUUID()}.out`);let transferPath='';let locked=false;let mutationAttempted=false;const priorState=ownership.state;
  try{
    const attributes=await adapter.datasetAttributes(ownership.dataset);if(!isOwnedSequentialAttributes(ownership.dataset,attributes))throw Object.assign(new Error('Owned target no longer matches PS/FB/LRECL=38.'),{code:'DATASET_ATTRIBUTES_MISMATCH'});
    const lock=await DatasetOwnership.updateOne({_id:ownership._id,ownerActorId:actorId,state:ownership.state},{$set:{state:'UPLOADING',lastOperationId:operationId}});if(lock.modifiedCount!==1)throw Object.assign(new Error('Another operation changed this dataset state.'),{code:'OWNED_DATASET_BUSY'});locked=true;
    operation.status='RUNNING';await operation.save();transferPath=await writeTransferCopy(parsed.records,uploadRoot);mutationAttempted=true;await uploadAdapter.upload(ownership.dataset,transferPath);
    await adapter.downloadDataset(ownership.dataset,downloadPath);const readback=await fs.readFile(downloadPath);const verified=validateDatasetUpload(readback);if(!sameRecords(parsed.records,verified.records))throw Object.assign(new Error('Remote read-back does not match the submitted fixed-width records.'),{code:'READBACK_CONTENT_MISMATCH'});
    await DatasetOwnership.updateOne({_id:ownership._id},{$set:{state:'ACTIVE',lastErrorCategory:null}});operation.status='SUCCEEDED';operation.evidence={...operation.evidence,verifiedRecordCount:verified.recordCount,contentMatch:true,verifiedAt:new Date()};await operation.save();await audit(action==='REPLACE'?'DATASET_REPLACED':'DATASET_UPLOADED','SUCCESS',{dataset:ownership.dataset,recordCount:verified.recordCount},operationId,undefined,req);return res.json({operationId,ownershipId:ownership._id,dataset:ownership.dataset,state:'ACTIVE',recordCount:verified.recordCount,contentMatch:true});
  }catch(error){const safe=safeZoweError(error);const code=(error as {code?:string}).code??safe.code;if(mutationAttempted)await DatasetOwnership.updateOne({_id:ownership._id},{$set:{state:'UNCERTAIN',lastErrorCategory:safe.code,lastOperationId:operationId}});else if(locked)await DatasetOwnership.updateOne({_id:ownership._id,state:'UPLOADING'},{$set:{state:priorState,lastErrorCategory:null}});operation.status=mutationAttempted?'UNCERTAIN':'FAILED';operation.errorCategory=safe.code;operation.errorMessage=safe.message;await operation.save();await audit(action==='REPLACE'?'DATASET_REPLACED':'DATASET_UPLOADED','FAILED',{dataset:ownership.dataset,errorCategory:safe.code,errorMessage:safe.message},operationId,undefined,req);return res.status(code==='AUTHORIZATION'?403:code==='TIMEOUT'?504:502).json({code:safe.code,message:safe.message,operationId,state:mutationAttempted?'UNCERTAIN':priorState});}
  finally{if(transferPath)await fs.unlink(transferPath).catch(()=>undefined);await fs.unlink(downloadPath).catch(()=>undefined);}
}));
app.delete('/api/mainframe/owned-datasets/:ownershipId', requireOperator, datasetMutationLimit, asyncRoute(async(req,res)=>{
  const actorId=(req as AuthRequest).actorId!;const idempotencyKey=req.get('Idempotency-Key')??'';
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))return res.status(400).json({code:'IDEMPOTENCY_KEY_REQUIRED',message:'A unique Idempotency-Key is required.'});
  if(!req.body||Object.keys(req.body).length!==1||typeof req.body.confirmDataset!=='string')return res.status(400).json({code:'EXACT_CONFIRMATION_REQUIRED',message:'Confirm the exact dataset name shown in the ownership record.'});
  const blockers=datasetMutationBlockers(process.env);if(blockers.length)return res.status(503).json({code:'DATASET_MUTATIONS_DISABLED',message:'Dataset deletion is disabled by server configuration.',blockers});
  if(!validObjectId(req.params.ownershipId))return res.status(404).json({code:'OWNED_DATASET_NOT_FOUND',message:'No app-owned dataset was found for this operator.'});const ownership=await DatasetOwnership.findOne({_id:req.params.ownershipId,ownerActorId:actorId});if(!ownership||!datasetAllowedForMutation(ownership.dataset,process.env))return res.status(404).json({code:'OWNED_DATASET_NOT_FOUND',message:'No app-owned dataset was found for this operator.'});
  if(req.body.confirmDataset.trim().toUpperCase()!==ownership.dataset)return res.status(400).json({code:'EXACT_CONFIRMATION_MISMATCH',message:'The confirmation must exactly match the app-owned dataset name.'});
  if(!['CREATED','ACTIVE'].includes(ownership.state))return res.status(409).json({code:'OWNED_DATASET_NOT_READY',message:'This dataset has an unresolved prior operation; deletion is refused.'});
  const prior=await DatasetOperation.findOne({actorId,idempotencyKey}).lean();if(prior)return res.status(409).json({code:'IDEMPOTENCY_KEY_REUSED',message:'This operation key was already used; no deletion was repeated.',operation:prior});
  const operationId=crypto.randomUUID();const operation=await createDatasetOperation({operationId,idempotencyKey,actorId,action:'DELETE',dataset:ownership.dataset,ownershipId:ownership._id,status:'PREPARED',evidence:{previousState:ownership.state}});if(!operation)return res.status(409).json({code:'IDEMPOTENCY_KEY_REUSED',message:'This operation key was already used; no deletion was started.'});const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});
  let locked=false;let deleteAttempted=false;const priorState=ownership.state;
  try{
    const attributes=await adapter.datasetAttributes(ownership.dataset);if(!isOwnedSequentialAttributes(ownership.dataset,attributes))throw Object.assign(new Error('Owned target no longer matches its recorded PS/FB/LRECL=38 attributes.'),{code:'DATASET_ATTRIBUTES_MISMATCH'});
    const lock=await DatasetOwnership.updateOne({_id:ownership._id,ownerActorId:actorId,state:ownership.state},{$set:{state:'DELETING',lastOperationId:operationId}});if(lock.modifiedCount!==1)throw Object.assign(new Error('Another operation changed this dataset state.'),{code:'OWNED_DATASET_BUSY'});locked=true;
    operation.status='RUNNING';await operation.save();deleteAttempted=true;await adapter.deleteDataset(ownership.dataset);
    try{await adapter.datasetAttributes(ownership.dataset);throw Object.assign(new Error('Dataset still exists after the delete operation.'),{code:'DELETE_NOT_VERIFIED'});}catch(error){if((error as {code?:string}).code!=='DATASET_NOT_FOUND')throw error;}
    await DatasetOwnership.updateOne({_id:ownership._id},{$set:{state:'DELETED',deletedAtRemote:new Date(),lastErrorCategory:null}});operation.status='SUCCEEDED';operation.evidence={verifiedAbsent:true,verifiedAt:new Date()};await operation.save();await audit('DATASET_DELETED','SUCCESS',{dataset:ownership.dataset},operationId,undefined,req);return res.json({operationId,dataset:ownership.dataset,state:'DELETED',verifiedAbsent:true});
  }catch(error){const safe=safeZoweError(error);if(deleteAttempted)await DatasetOwnership.updateOne({_id:ownership._id},{$set:{state:'UNCERTAIN',lastErrorCategory:safe.code,lastOperationId:operationId}});else if(locked)await DatasetOwnership.updateOne({_id:ownership._id,state:'DELETING'},{$set:{state:priorState,lastErrorCategory:null}});operation.status=deleteAttempted?'UNCERTAIN':'FAILED';operation.errorCategory=safe.code;operation.errorMessage=safe.message;await operation.save();await audit('DATASET_DELETED','FAILED',{dataset:ownership.dataset,errorCategory:safe.code,errorMessage:safe.message},operationId,undefined,req);return res.status(safe.code==='AUTHORIZATION'?403:safe.code==='TIMEOUT'?504:502).json({code:safe.code,message:safe.message,operationId,state:deleteAttempted?'UNCERTAIN':priorState});}
}));
app.post('/api/mainframe/owned-datasets/:ownershipId/reconcile', requireOperator, datasetMutationLimit, asyncRoute(async(req,res)=>{
  const actorId=(req as AuthRequest).actorId!;const idempotencyKey=req.get('Idempotency-Key')??'';
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))return res.status(400).json({code:'IDEMPOTENCY_KEY_REQUIRED',message:'A unique Idempotency-Key is required.'});
  const recoveryBlockers=datasetMutationBlockers(process.env);if(recoveryBlockers.length)return res.status(503).json({code:'RECOVERY_SCOPE_REQUIRED',message:'Read-only recovery checks require the dataset-mutation scope to be configured.',blockers:recoveryBlockers});
  if(!validObjectId(req.params.ownershipId))return res.status(404).json({code:'OWNED_DATASET_NOT_FOUND',message:'No app-owned dataset was found for this operator.'});
  const ownership=await DatasetOwnership.findOne({_id:req.params.ownershipId,ownerActorId:actorId});if(!ownership||ownership.state!=='UNCERTAIN'||!ownership.lastOperationId||!datasetAllowedForMutation(ownership.dataset,process.env))return res.status(409).json({code:'RECOVERY_NOT_AVAILABLE',message:'Only an uncertain, manifest-owned dataset can be reconciled.'});
  const prior=await DatasetOperation.findOne({actorId,idempotencyKey}).lean();if(prior)return res.status(409).json({code:'IDEMPOTENCY_KEY_REUSED',message:'This recovery key was already used; no remote action was repeated.',operation:prior});
  const original=await DatasetOperation.findOne({operationId:ownership.lastOperationId,actorId,ownershipId:ownership._id,status:'UNCERTAIN'});if(!original||!['CREATE','UPLOAD','REPLACE','DELETE'].includes(original.action))return res.status(409).json({code:'RECOVERY_EVIDENCE_MISSING',message:'The original uncertain operation evidence is unavailable.'});
  const recoveryId=crypto.randomUUID();const recovery=await createDatasetOperation({operationId:recoveryId,idempotencyKey,actorId,action:'RECOVER',dataset:ownership.dataset,ownershipId:ownership._id,status:'PREPARED',evidence:{originalOperationId:original.operationId}});if(!recovery)return res.status(409).json({code:'IDEMPOTENCY_KEY_REUSED',message:'This recovery key was already used.'});
  recovery.status='RUNNING';await recovery.save();const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});const localPath=path.join(uploadRoot,`${crypto.randomUUID()}.out`);
  try{
    let attributes:Record<string,unknown>|undefined;let exists=true;
    try{attributes=await adapter.datasetAttributes(ownership.dataset);}catch(error){if((error as {code?:string}).code==='DATASET_NOT_FOUND')exists=false;else throw error;}
    const attributesMatch=exists&&attributes!==undefined&&isOwnedSequentialAttributes(ownership.dataset,attributes);
    let contentMatch=false;
    if(exists&&attributesMatch&&(original.action==='UPLOAD'||original.action==='REPLACE')){
      await adapter.downloadDataset(ownership.dataset,localPath);const remote=validateDatasetUpload(await fs.readFile(localPath));const evidence=original.evidence as {expectedContentSha256?:unknown;recordCount?:unknown};contentMatch=remote.recordCount===evidence.recordCount&&canonicalRecordsSha256(remote.records)===evidence.expectedContentSha256;
    }
    const originalEvidence=original.evidence as {previousState?:unknown;allocationCommandSucceeded?:unknown};const previousState=originalEvidence.previousState==='ACTIVE'||originalEvidence.previousState==='CREATED'?originalEvidence.previousState:undefined;
    const decision=decideDatasetRecovery(original.action as 'CREATE'|'UPLOAD'|'REPLACE'|'DELETE',{exists,attributesMatch,contentMatch,createCommandSucceeded:originalEvidence.allocationCommandSucceeded===true},previousState);
    recovery.evidence={...recovery.evidence,exists,attributesMatch,contentMatch,checkedAt:new Date(),resolved:decision.resolved};
    if(!decision.resolved){recovery.status='FAILED';recovery.errorCategory='RECOVERY_UNRESOLVED';recovery.errorMessage=decision.message;await recovery.save();await audit('DATASET_RECOVERY_CHECKED','ERROR',{dataset:ownership.dataset,operationId:original.operationId,reason:decision.message},recoveryId,undefined,req);return res.status(409).json({code:'RECOVERY_UNRESOLVED',message:decision.message,operationId:recoveryId,state:'UNCERTAIN'});}
    ownership.state=decision.ownershipState;ownership.lastErrorCategory=undefined;if(decision.ownershipState==='CREATED'&&original.action==='CREATE')ownership.createdAtRemote=new Date();if(decision.ownershipState==='DELETED')ownership.deletedAtRemote=new Date();await ownership.save();original.status=decision.operationStatus;original.evidence={...original.evidence,recoveredAt:new Date(),recoveryOperationId:recoveryId};await original.save();recovery.status='SUCCEEDED';recovery.evidence={...recovery.evidence,message:decision.message};await recovery.save();await audit('DATASET_RECOVERY_CHECKED','SUCCESS',{dataset:ownership.dataset,operationId:original.operationId,state:ownership.state},recoveryId,undefined,req);return res.json({operationId:recoveryId,originalOperationId:original.operationId,dataset:ownership.dataset,state:ownership.state,message:decision.message,evidence:recovery.evidence});
  }catch(error){const safe=safeZoweError(error);recovery.status='FAILED';recovery.errorCategory=safe.code;recovery.errorMessage=safe.message;await recovery.save();await audit('DATASET_RECOVERY_CHECKED','FAILED',{dataset:ownership.dataset,errorCategory:safe.code,errorMessage:safe.message},recoveryId,undefined,req);return res.status(safe.code==='AUTHORIZATION'?403:safe.code==='TIMEOUT'?504:502).json({code:safe.code,message:safe.message,operationId:recoveryId,state:'UNCERTAIN'});}
  finally{await fs.unlink(localPath).catch(()=>undefined);}
}));
app.get('/api/organizations', asyncRoute(async (_req,res) => res.json(await Organization.find({ active:true }).sort({name:1}).select('name code active createdAt').lean())));
app.post('/api/organizations', requireOperator, asyncRoute(async (req,res) => {
  const parsed = organizationInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ code:'VALIDATION_ERROR', message:'Organization name and short code are required.', issues:parsed.error.issues });
  try { const org = await Organization.create(parsed.data); await audit('ORGANIZATION_CREATED','SUCCESS',{ code:org.code },undefined,String(org._id),req); return res.status(201).json(org); }
  catch (error) { if ((error as {code?:number}).code === 11000) return res.status(409).json({code:'ORGANIZATION_CODE_EXISTS',message:'That organization code is already in use.'}); throw error; }
}));
app.post('/api/uploads/:kind', requireOperator, upload.single('file'), asyncRoute(async (req,res) => {
  const kind = req.params.kind; if (kind !== 'transaction' && kind !== 'settlement') return res.status(400).json({code:'INVALID_UPLOAD_KIND',message:'Upload kind must be transaction or settlement.'});
  if (!req.file) return res.status(400).json({code:'FILE_REQUIRED',message:'Choose a .txt file within the configured size limit.'});
  const orgId = String(req.body.organizationId ?? ''); if (!/^[a-f\d]{24}$/i.test(orgId)) return res.status(400).json({code:'ORGANIZATION_REQUIRED',message:'Select a valid organization first.'});
  const org = await Organization.findById(orgId); if (!org) return res.status(404).json({code:'ORGANIZATION_NOT_FOUND',message:'Organization not found.'});
  const contract = validateFixedWidthFile(req.file.buffer); const uploadId = crypto.randomUUID(); await fs.mkdir(uploadRoot,{recursive:true});
  const stagedPath = path.join(uploadRoot,`${uploadId}.txt`); await fs.writeFile(stagedPath,req.file.buffer,{flag:'wx',mode:0o600});
  const sha256=crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const saved = await Upload.create({ uploadId,organization:org._id,kind,originalName:path.basename(req.file.originalname),size:req.file.size,sha256,recordCount:contract.recordCount,valid:contract.valid,validationErrors:contract.errors,preview:contract.preview,stagedPath,expiresAt:new Date(Date.now()+24*60*60*1000) }) as unknown as {uploadId:string;originalName:string;size:number;recordCount:number;valid:boolean;validationErrors:string[];preview:string[];expiresAt:Date};
  await audit('UPLOAD_CREATED',contract.valid?'VALID':'CONTRACT_ERRORS',{kind,size:req.file.size,recordCount:contract.recordCount,errors:contract.errors},undefined,String(org._id),req);
  return res.status(201).json({uploadId:saved.uploadId,kind,originalName:saved.originalName,size:saved.size,recordCount:saved.recordCount,valid:saved.valid,errors:saved.validationErrors,preview:saved.preview,expiresAt:saved.expiresAt});
}));
app.post('/api/mainframe/upload-verification/preview', requireOperator, asyncRoute(async (req,res) => {
  const parsed = uploadVerificationPreviewInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code:'VALIDATION_ERROR', message:'Select an organization and both validated uploads.', issues:parsed.error.issues });
  const { organizationId, transactionUploadId, settlementUploadId } = parsed.data;
  const [orgResult, txnResult, setResult] = await Promise.all([
    Organization.findOne({ _id:organizationId, active:true }).select('name').lean(),
    Upload.findOne({ uploadId:transactionUploadId, organization:organizationId, kind:'transaction' }).select('uploadId originalName size sha256 recordCount valid stagedPath').lean(),
    Upload.findOne({ uploadId:settlementUploadId, organization:organizationId, kind:'settlement' }).select('uploadId originalName size sha256 recordCount valid stagedPath').lean(),
  ]);
  const org = orgResult as unknown as { _id: unknown; name: string } | null;
  const txn = txnResult as unknown as SmokeInput | null;
  const set = setResult as unknown as SmokeInput | null;
  if (!org || !txn || !set) return res.status(400).json({ code:'UPLOADS_REQUIRED', message:'Both uploads must belong to the selected active organization.' });
  if (!txn.valid || !set.valid) return res.status(422).json({ code:'FILE_CONTRACT_INVALID', message:'Both uploads must pass the 38-byte fixed-width contract.' });
  try {
    const planned = buildUploadVerificationPlan({ hlq:process.env.MAINFRAME_HLQ?.trim() ?? '', transaction:txn, settlement:set });
    const actorId = (req as AuthRequest).actorId ?? 'anonymous';
    const operationId = crypto.randomUUID();
    const record: UploadVerificationRecord = {
      operationId, organizationId, organizationName:org.name, actorId,
      transaction: { uploadId:txn.uploadId, kind:'transaction', originalName:txn.originalName, size:txn.size, sha256:txn.sha256, recordCount:txn.recordCount, valid:txn.valid, stagedPath:txn.stagedPath },
      settlement: { uploadId:set.uploadId, kind:'settlement', originalName:set.originalName, size:set.size, sha256:set.sha256, recordCount:set.recordCount, valid:set.valid, stagedPath:set.stagedPath },
      runQualifier:planned.runQualifier, datasets:planned.datasets, status:'PREPARED', stage:'PREPARED', stageResults:{ allocationTracks:planned.primaryTracks },
    };
    await UploadVerification.create(record);
    let gateReady = false; let gateMessage = 'Administrator execution flags and mainframe configuration are not ready.';
    try { validateSmokeConfiguration(process.env); gateReady = true; gateMessage = 'Configuration gates are enabled. Connection readiness is rechecked before any remote operation.'; }
    catch (error) { gateMessage = sanitizeText((error as Error).message, 200); }
    await audit('MAINFRAME_UPLOAD_TEST_PLANNED','SUCCESS',{ datasetCount:2, gateReady },operationId,organizationId,req);
    return res.status(201).json({ ...safeUploadVerificationResponse(record), canStart:gateReady, gateMessage });
  } catch (error) {
    const message = sanitizeText((error as Error).message ?? 'Upload-verification plan could not be created.', 200);
    await audit('MAINFRAME_UPLOAD_TEST_PLANNED','FAILED',{ errorCategory:'PLAN_VALIDATION', errorMessage:message },undefined,organizationId,req);
    return res.status(422).json({ code:'UPLOAD_VERIFICATION_PLAN_INVALID', message });
  }
}));
app.post('/api/mainframe/upload-verification/:operationId/start', requireOperator, uploadVerificationLimit, asyncRoute(async (req,res) => {
  const parsed = uploadVerificationStartInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code:'CONFIRMATION_REQUIRED', message:'Confirm the two exact run-specific dataset names shown in the preview.' });
  try { validateSmokeConfiguration(process.env); }
  catch (error) { return res.status(503).json({ code:(error as {code?:string}).code ?? 'MAINFRAME_CONFIGURATION_INVALID', message:sanitizeText((error as Error).message, 200) }); }
  const actorId = (req as AuthRequest).actorId ?? '';
  const existing = await UploadVerification.findOne({ operationId:req.params.operationId, actorId }).lean().exec() as unknown as UploadVerificationRecord | null;
  if (!existing) return res.status(404).json({ code:'UPLOAD_VERIFICATION_NOT_FOUND', message:'The prepared operation was not found for this operator.' });
  const expected = existing.datasets.map((item) => item.name);
  if (parsed.data.confirmDatasets.length !== expected.length || expected.some((name,index) => name !== parsed.data.confirmDatasets[index])) return res.status(409).json({ code:'DATASET_CONFIRMATION_MISMATCH', message:'The confirmed dataset names do not match this persisted operation.' });
  const locked = await UploadVerification.findOneAndUpdate({ operationId:existing.operationId, actorId, status:'PREPARED' }, { $set:{ status:'RUNNING', stage:'STARTING', stageResults:{ ...existing.stageResults, startedAt:new Date().toISOString() } } }, { new:true }).lean().exec() as unknown as UploadVerificationRecord | null;
  if (!locked) return res.status(409).json({ code:'OPERATION_ALREADY_STARTED', message:'This operation has already started or reached a terminal state. Inspect its saved status; do not resubmit it.' });
  await audit('MAINFRAME_UPLOAD_TEST_STARTED','SUCCESS',{ datasetCount:2 },existing.operationId,existing.organizationId,req);
  const adapter = createZoweUploadAdapter({ timeoutMs:resolveZoweTimeoutMs(process.env), stagingRoot:uploadRoot });
  void executeUploadVerification(locked, {
    env:process.env, stagingRoot:uploadRoot, adapter,
    checkReadiness:async()=>{ const result=await testZoweProfile({ timeoutMs:resolveZoweTimeoutMs(process.env), log:(level,stage,details={})=>logStructured(level,{event:'mainframe.upload_test_readiness',requestId:resRequestId(req),stage,...details}) }); return { state:result.state, message:result.message }; },
    persist:async(record)=>{ await UploadVerification.updateOne({operationId:record.operationId},{$set:{status:record.status,stage:record.stage,datasets:record.datasets,stageResults:record.stageResults,errorCategory:record.errorCategory,errorMessage:record.errorMessage}}); },
  }).then(async result=>{await audit('MAINFRAME_UPLOAD_TEST_FINISHED',result.status==='VERIFIED'?'SUCCESS':result.status.includes('WARNING')?'ERROR':'FAILED',{status:result.status,errorCategory:result.errorCategory},result.operationId,result.organizationId,req);logStructured(result.status==='VERIFIED'?'info':'warn',{event:'mainframe.upload_test_finished',operationId:result.operationId,status:result.status,stage:result.stage,...(result.stageResults.localReadbackCleanup?{localReadbackCleanup:result.stageResults.localReadbackCleanup}:{})});}).catch(async error=>{const category=(error as {code?:string}).code??'CLI_ERROR';const safe=safeSmokeErrorMessage(error);await UploadVerification.updateOne({operationId:existing.operationId},{$set:{status:'FAILED',stage:'FAILED',errorCategory:category,errorMessage:safe}});await audit('MAINFRAME_UPLOAD_TEST_FINISHED','FAILED',{errorCategory:category,errorMessage:safe},existing.operationId,existing.organizationId,req);logStructured('error',{event:'mainframe.upload_test_failed',operationId:existing.operationId,errorCategory:category,errorMessage:safe});});
  return res.status(202).json({ ...safeUploadVerificationResponse(locked), message:'The dedicated file-transfer verification has started. It does not submit JCL or run reconciliation.' });
}));
app.get('/api/mainframe/upload-verification/:operationId', requireOperator, asyncRoute(async (req,res) => {
  let record = await UploadVerification.findOne({operationId:req.params.operationId,actorId:(req as AuthRequest).actorId}).lean().exec() as unknown as (UploadVerificationRecord & {updatedAt?:Date})|null;
  if (!record) return res.status(404).json({code:'UPLOAD_VERIFICATION_NOT_FOUND',message:'The upload-verification operation was not found for this operator.'});
  const staleBefore = new Date(Date.now() - 20 * 60_000);
  if (record.status === 'RUNNING' && record.updatedAt && record.updatedAt < staleBefore) {
    const terminal = record.datasets.some(item=>['CREATED','CREATING','CLEANING','UNKNOWN','CLEANUP_FAILED'].includes(item.state)) ? 'CLEANUP_FAILED' : 'FAILED';
    const recovery = await UploadVerification.updateOne({operationId:record.operationId,actorId:record.actorId,status:'RUNNING',updatedAt:{$lt:staleBefore}},{$set:{status:terminal,stage:'INTERRUPTED',errorCategory:'PROCESS_INTERRUPTED',errorMessage:'No persisted stage update was received for 20 minutes. Reconcile any uncertain dataset state with the mainframe owner before retrying cleanup.'}});
    if(recovery.modifiedCount)await audit('MAINFRAME_UPLOAD_TEST_INTERRUPTED','FAILED',{status:terminal,errorCategory:'PROCESS_INTERRUPTED'},record.operationId,record.organizationId,req);
    record = await UploadVerification.findOne({operationId:record.operationId,actorId:record.actorId}).lean().exec() as unknown as (UploadVerificationRecord & {updatedAt?:Date})|null;
  }
  return record ? res.json(safeUploadVerificationResponse(record)) : res.status(404).json({code:'UPLOAD_VERIFICATION_NOT_FOUND',message:'The upload-verification operation was not found for this operator.'});
}));
app.post('/api/mainframe/upload-verification/:operationId/cleanup', requireOperator, uploadVerificationLimit, asyncRoute(async (req,res) => {
  try { validateSmokeConfiguration(process.env); } catch(error) { return res.status(503).json({code:(error as {code?:string}).code??'MAINFRAME_CONFIGURATION_INVALID',message:sanitizeText((error as Error).message,200)}); }
  const actorId=(req as AuthRequest).actorId??'';
  const record=await UploadVerification.findOne({operationId:req.params.operationId,actorId,status:{$in:['FAILED','CLEANUP_FAILED','VERIFIED_WITH_CLEANUP_WARNING']}}).lean().exec() as unknown as UploadVerificationRecord|null;
  if(!record)return res.status(409).json({code:'CLEANUP_NOT_AVAILABLE',message:'Only a terminal operation with tracked cleanup work can be retried.'});
  const connection = await testZoweProfile({timeoutMs:resolveZoweTimeoutMs(process.env),log:(level,stage,details={})=>logStructured(level,{event:'mainframe.upload_test_cleanup_readiness',requestId:resRequestId(req),stage,...details})});
  if(connection.state!=='DATASET_ACCESS_VERIFIED')return res.status(503).json({code:'MAINFRAME_NOT_READY',message:connection.message});
  const locked=await UploadVerification.findOneAndUpdate({operationId:record.operationId,actorId,status:record.status},{$set:{status:'RUNNING',stage:'CLEANUP_RETRY'}},{new:true}).lean().exec() as unknown as UploadVerificationRecord|null;
  if(!locked)return res.status(409).json({code:'OPERATION_ALREADY_STARTED',message:'Cleanup is already running or the operation state changed.'});
  const adapter=createZoweUploadAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});
  const result=await retryUploadVerificationCleanup(locked,{env:process.env,stagingRoot:uploadRoot,adapter,checkReadiness:async()=>({state:'NOT_USED'}),persist:async(value)=>{await UploadVerification.updateOne({operationId:value.operationId},{$set:{status:value.status,stage:value.stage,datasets:value.datasets,stageResults:value.stageResults,errorCategory:value.errorCategory,errorMessage:value.errorMessage}});}});
  await audit('MAINFRAME_UPLOAD_TEST_CLEANUP',result.datasets.some(item=>item.state==='CLEANUP_FAILED')?'FAILED':'SUCCESS',{remainingDatasets:result.datasets.filter(item=>['CLEANUP_FAILED','UNKNOWN','CREATING'].includes(item.state)).length},result.operationId,result.organizationId,req);
  return res.json(safeUploadVerificationResponse(result));
}));
app.post('/api/runs/preview', requireOperator, asyncRoute(async (req,res) => {
  const parsed=previewInput.safeParse(req.body); if(!parsed.success) return res.status(400).json({code:'VALIDATION_ERROR',message:'Plan preview request is invalid.',issues:parsed.error.issues});
  const {organizationId,transactionUploadId,settlementUploadId,profile}=parsed.data;
  const [orgResult,txnResult,setResult]=await Promise.all([
    Organization.findOne({_id:organizationId,active:true}).select('name').lean(),
    Upload.findOne({uploadId:transactionUploadId,organization:organizationId,kind:'transaction'}).select('uploadId originalName size recordCount valid').lean(),
    Upload.findOne({uploadId:settlementUploadId,organization:organizationId,kind:'settlement'}).select('uploadId originalName size recordCount valid').lean(),
  ]);
  const org=orgResult as unknown as { _id:unknown; name:string }|null;
  const txn=txnResult as unknown as { originalName:string; size:number; recordCount:number; valid:boolean }|null;
  const set=setResult as unknown as { originalName:string; size:number; recordCount:number; valid:boolean }|null;
  if(!org||!txn||!set) return res.status(400).json({code:'UPLOADS_REQUIRED',message:'Select an active organization and both uploads belonging to it.'});
  if(!txn.valid||!set.valid) return res.status(422).json({code:'FILE_CONTRACT_INVALID',message:'Both uploads must pass the 38-byte file-contract checks.'});
  try {
    const plan=buildExecutionPlanPreview({
      runId:createRunId(), organization:{id:String(org._id),name:org.name}, profile,
      transaction:{originalName:txn.originalName,size:txn.size,recordCount:txn.recordCount,valid:txn.valid},
      settlement:{originalName:set.originalName,size:set.size,recordCount:set.recordCount,valid:set.valid},
      config:{hlq:process.env.MAINFRAME_HLQ?.trim()||'Z73968',jobClass:process.env.MAINFRAME_JOB_CLASS?.trim()||'7',sourceLibrary:process.env.MAINFRAME_SOURCE_LIBRARY?.trim()||'Z73968.SOURCE',loadLibrary:process.env.MAINFRAME_LOAD_LIBRARY?.trim()||'Z73968.LOAD',loadModule:process.env.MAINFRAME_LOAD_MODULE?.trim()||'RECONCIL',rexxMember:process.env.MAINFRAME_REXX_MEMBER?.trim()||'VALIDATE'},maxUploadBytes:maxBytes,
    });
    await ExecutionPlan.create({planId:plan.runId,organization:org._id,transactionUploadId,settlementUploadId,profile,plan,expiresAt:new Date(Date.now()+30*60*1000)});
    await audit('EXECUTION_PLAN_PREVIEWED','SUCCESS',{profile,transactionRecords:txn.recordCount,settlementRecords:set.recordCount},plan.runId,organizationId,req);
    return res.json({...plan,planId:plan.runId});
  } catch(error) {
    const message=error instanceof Error?sanitizeText(error.message,240):'Execution plan validation failed.';
    await audit('EXECUTION_PLAN_PREVIEWED','FAILED',{profile,errorCategory:'PLAN_VALIDATION',errorMessage:message},undefined,organizationId,req);
    return res.status(422).json({code:'PLAN_VALIDATION_FAILED',message});
  }
}));
app.get('/api/uploads/:uploadId', requireOperator, asyncRoute(async (req,res) => { const item=await Upload.findOne({uploadId:req.params.uploadId}).select('-stagedPath -sha256').lean(); if(!item)return res.status(404).json({code:'UPLOAD_NOT_FOUND',message:'Upload not found or temporary staging expired.'});const stored=item as unknown as {validationErrors?:string[];errors?:string[]};return res.json({...item,errors:stored.validationErrors??stored.errors??[]}); }));
app.post('/api/runs', requireOperator, asyncRoute(async (req,res) => {
  const parsed=runInput.safeParse(req.body); if(!parsed.success) return res.status(400).json({code:'VALIDATION_ERROR',message:'Run request is invalid.',issues:parsed.error.issues});
  const {organizationId,transactionUploadId,settlementUploadId,profile}=parsed.data;
  const state=readiness();
  const [org,txn,set]=await Promise.all([Organization.findById(organizationId),Upload.findOne({uploadId:transactionUploadId,organization:organizationId,kind:'transaction'}),Upload.findOne({uploadId:settlementUploadId,organization:organizationId,kind:'settlement'})]);
  if(!org || !txn || !set) return res.status(400).json({code:'UPLOADS_REQUIRED',message:'Both current uploads and their organization are required.'});
  if(!txn.valid||!set.valid) return res.status(422).json({code:'FILE_CONTRACT_INVALID',message:'Resolve file contract errors before requesting a run.'});
  const storedPlan=await ExecutionPlan.findOne({planId:parsed.data.planId,organization:org._id,transactionUploadId,settlementUploadId,profile,expiresAt:{$gt:new Date()}}).lean() as unknown as {plan:Record<string,unknown>}|null;
  if(!storedPlan)return res.status(409).json({code:'PLAN_EXPIRED_OR_MISMATCHED',message:'Preview this exact organization and upload pair again before requesting execution.'});
  const [txnBytes,setBytes]=await Promise.all([fs.readFile(txn.stagedPath),fs.readFile(set.stagedPath)]);
  const txnHash=crypto.createHash('sha256').update(txnBytes).digest('hex');const setHash=crypto.createHash('sha256').update(setBytes).digest('hex');
  if(txnBytes.length!==txn.size||setBytes.length!==set.size||txnHash!==txn.sha256||setHash!==set.sha256||!validateFixedWidthFile(txnBytes).valid||!validateFixedWidthFile(setBytes).valid)return res.status(409).json({code:'STAGED_INPUT_CHANGED',message:'The staged files no longer match the validated upload metadata. Upload them again.'});
  const idempotencyKey=req.get('Idempotency-Key');
  if(!idempotencyKey||!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))return res.status(400).json({code:'IDEMPOTENCY_KEY_REQUIRED',message:'A unique idempotency key is required for every reconciliation request.'});
  if(await Run.exists({$or:[{idempotencyKey},{runId:parsed.data.planId}]}))return res.status(409).json({code:'DUPLICATE_SUBMISSION',message:'This run request or plan has already been recorded. Inspect its persisted status before retrying.'});
  const runId=parsed.data.planId;
  const planData=storedPlan.plan as {datasets?:Array<{name:string;purpose:string;state:string}>;cleanupManifest?:unknown};
  // This API intentionally records a blocked request until the complete, reviewed
  // multi-job executor exists. Do not fall through to the legacy one-job adapter.
  const blockers = [...state.reconciliationBlockers, 'The run-specific orchestration is not wired as a production adapter, and generated jobs/output contracts have not been validated on z/OS.'];
  const run=await Run.create({runId,idempotencyKey,organization:org._id,organizationName:org.name,status:'NOT_CONFIGURED',profile,inputs:{transaction:{uploadId:txn.uploadId,originalName:txn.originalName,size:txn.size,sha256:txn.sha256,recordCount:txn.recordCount,valid:txn.valid},settlement:{uploadId:set.uploadId,originalName:set.originalName,size:set.size,sha256:set.sha256,recordCount:set.recordCount,valid:set.valid}},plan:storedPlan.plan,datasetManifest:(planData.datasets??[]).map((dataset)=>({name:dataset.name,purpose:dataset.purpose,state:'PLANNED_NOT_CREATED'})),stateTransitions:[{status:'NOT_CONFIGURED',at:new Date(),actorId:(req as AuthRequest).actorId}],summary:{},diagnostics:blockers,errorCode:'MAINFRAME_RECONCILIATION_NOT_CONFIGURED'});
  await Report.create({run:run._id}); await audit('RUN_REQUESTED','BLOCKED',{profile,blockerCount:blockers.length},runId,String(org._id),req);
  return res.status(503).json({code:'MAINFRAME_RECONCILIATION_NOT_CONFIGURED',message:'Uploads and the preview were validated, but no reconciliation job was submitted. Resolve the listed execution blockers before a controlled live run.',blockers,runId,status:run.status});
}));
app.get('/api/runs', requireOperator, asyncRoute(async (req,res) => {
  const parsed=historyQuery.safeParse(req.query);if(!parsed.success)return res.status(400).json({code:'VALIDATION_ERROR',issues:parsed.error.issues}); const q=parsed.data;
  const filter:Record<string,unknown>={};if(q.status)filter.status=q.status;if(q.search)filter.$or=[{runId:{$regex:q.search,$options:'i'}},{organizationName:{$regex:q.search,$options:'i'}},{'inputs.transaction.originalName':{$regex:q.search,$options:'i'}},{'inputs.settlement.originalName':{$regex:q.search,$options:'i'}}];
  const [items,total]=await Promise.all([Run.find(filter).sort({[q.sort]:q.order==='asc'?1:-1}).skip((q.page-1)*q.pageSize).limit(q.pageSize).lean(),Run.countDocuments(filter)]);
  return res.json({items:items.map(scrubRunStoragePaths),total,page:q.page,pageSize:q.pageSize,totalPages:Math.ceil(total/q.pageSize)});
}));
app.get('/api/runs/:runId/job-status', requireOperator, asyncRoute(async(req,res)=>{
  const run=await Run.findOne({runId:req.params.runId});if(!run)return res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});if(!run.jobId)return res.status(409).json({code:'JES_JOB_NOT_ASSOCIATED',message:'No actual JES job ID is associated with this run; no status query was made.'});
  try{const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});const status=await adapter.jobStatus(run.jobId);run.jobStatus=status.status;run.returnCode=status.returnCode??undefined;await run.save();await audit('JES_STATUS_READ','SUCCESS',{jobId:status.jobId,status:status.status,returnCode:status.returnCode},run.runId,String(run.organization),req);return res.json({runId:run.runId,submittedAt:run.createdAt,...status,steps:run.stepResults??[],businessSummary:run.summary??{},eodDecision:run.eodDecision??'NOT_AVAILABLE'});}
  catch(error){const safe=safeZoweError(error);await audit('JES_STATUS_READ','FAILED',{jobId:run.jobId,errorCategory:safe.code,errorMessage:safe.message},run.runId,String(run.organization),req);return res.status(safe.code==='AUTHORIZATION'?403:safe.code==='TIMEOUT'?504:502).json({code:safe.code,message:safe.message,runId:run.runId,jobId:run.jobId});}
}));
app.get('/api/runs/:runId/spool', requireOperator, asyncRoute(async(req,res)=>{
  const run=await Run.findOne({runId:req.params.runId});if(!run)return res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});if(!run.jobId)return res.status(409).json({code:'JES_JOB_NOT_ASSOCIATED',message:'No actual JES job ID is associated with this run; no spool query was made.'});
  try{const adapter=createZoweReconciliationAdapter({timeoutMs:resolveZoweTimeoutMs(process.env),stagingRoot:uploadRoot});const raw=await adapter.jobSpool(run.jobId);const safeText=raw.split('\n').map((line)=>sanitizeText(line,4000)).join('\n');const limit=1024*1024;const spoolText=safeText.slice(0,limit);const evidence=await JobEvidence.findOneAndUpdate({runId:run.runId,jobId:run.jobId},{$set:{status:run.jobStatus??'UNKNOWN',returnCode:run.returnCode??null,spoolText,spoolTruncated:safeText.length>limit,retrievedAt:new Date()}},{upsert:true,new:true,setDefaultsOnInsert:true});await audit('JES_SPOOL_RETRIEVED','SUCCESS',{jobId:run.jobId,characters:spoolText.length,truncated:safeText.length>limit},run.runId,String(run.organization),req);return res.json({runId:run.runId,jobId:run.jobId,status:run.jobStatus??'UNKNOWN',returnCode:run.returnCode??null,retrievedAt:evidence.retrievedAt,spoolText:evidence.spoolText,spoolTruncated:evidence.spoolTruncated});}
  catch(error){const safe=safeZoweError(error);await audit('JES_SPOOL_RETRIEVED','FAILED',{jobId:run.jobId,errorCategory:safe.code,errorMessage:safe.message},run.runId,String(run.organization),req);return res.status(safe.code==='AUTHORIZATION'?403:safe.code==='TIMEOUT'?504:502).json({code:safe.code,message:safe.message,runId:run.runId,jobId:run.jobId});}
}));
app.get('/api/runs/:runId', requireOperator, asyncRoute(async (req,res) => {const run=await Run.findOne({runId:req.params.runId}).populate('organization','name code').lean();return run?res.json(scrubRunStoragePaths(run)):res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});}));
app.get('/api/runs/:runId/report', requireOperator, asyncRoute(async(req,res)=>{const run=await Run.findOne({runId:req.params.runId}).lean().exec() as unknown as ExportRun|null;if(!run)return res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});return res.json({organizationName:run.organizationName,runId:run.runId,status:run.status,profile:run.profile,submittedAt:run.createdAt,completedAt:run.completedAt??null,inputs:run.inputs,summary:run.summary,jobId:run.jobId??null,jobStatus:run.jobStatus??null,returnCode:run.returnCode??null,stepResults:run.stepResults??[],datasetManifest:run.datasetManifest??[],outputReferences:(run.outputReferences??[]).map((reference)=>Object.fromEntries(Object.entries(reference).filter(([key])=>key!=='localPath'))),cleanupStatus:run.cleanupStatus??null,eodDecision:run.eodDecision??'NOT_AVAILABLE',diagnostics:run.diagnostics??[],errorCode:run.errorCode??null});}));
app.get('/api/runs/:runId/export.csv', requireOperator, asyncRoute(async(req,res)=>{const run=await Run.findOne({runId:req.params.runId}).lean().exec() as unknown as ExportRun|null;if(!run)return res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});const s=run.summary;const rows=[['Organization',run.organizationName],['Run ID',run.runId],['Status',run.status],['Profile',run.profile],['Submitted',run.createdAt.toISOString()],['Transaction input records',String(run.inputs.transaction?.recordCount??'')],['Settlement input records',String(run.inputs.settlement?.recordCount??'')],['Matched',String(s.matchedCount??'Not available in current mainframe output')],['Mismatched',String(s.mismatchedCount??'Not available in current mainframe output')],['Transaction only',String(s.transactionOnlyCount??'Not available in current mainframe output')],['Settlement only',String(s.settlementOnlyCount??'Not available in current mainframe output')],['Transaction amount',String(s.transactionAmount??'Not available in current mainframe output')],['Settlement amount',String(s.settlementAmount??'Not available in current mainframe output')],['Validated amount',String(s.validatedAmount??'Not available in current mainframe output')],['Discrepancy amount',String(s.discrepancyAmount??'Not available in current mainframe output')],['JES job ID',run.jobId??'Not available'],['JES status',run.jobStatus??'Not available'],['Return code',String(run.returnCode??'Not available')],['EOD publication decision',run.eodDecision??'Not available']];for(const [index,step] of (run.stepResults??[]).entries())rows.push([`Step ${index+1} name`,String(step.stepName??step.stage??'Not available')],[`Step ${index+1} status`,String(step.status??'Not available')],[`Step ${index+1} return code`,String(step.returnCode??'Not available')],[`Step ${index+1} condition code`,String(step.conditionCode??'Not available')]);for(const [index,output] of (run.outputReferences??[]).entries())rows.push([`Output ${index+1} dataset`,String(output.dataset??output.name??'Not available')],[`Output ${index+1} availability`,String(output.state??output.status??'Not available')]);res.type('text/csv').attachment(`${run.runId}.csv`).send(rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n'));}));
app.get('/api/runs/:runId/export.pdf', requireOperator, asyncRoute(async(req,res)=>{const run=await Run.findOne({runId:req.params.runId}).lean().exec() as unknown as ExportRun|null;if(!run)return res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});res.type('application/pdf').attachment(`${run.runId}.pdf`);const doc=new PDFDocument({margin:56});doc.pipe(res);doc.fontSize(20).text('Reconciliation run report');doc.moveDown().fontSize(11).text(`Organization: ${run.organizationName}`).text(`Run ID: ${run.runId}`).text(`Status: ${run.status}`).text(`Profile: ${run.profile}`).text(`Submitted: ${run.createdAt.toISOString()}`).text(`Completed: ${run.completedAt?.toISOString()??'Not available'}`);doc.moveDown().text('Input files');const inputs=run.inputs;doc.text(`Transactions: ${inputs.transaction?.originalName??'—'} (${inputs.transaction?.recordCount??'—'} records)`).text(`Settlements: ${inputs.settlement?.originalName??'—'} (${inputs.settlement?.recordCount??'—'} records)`);const s=run.summary;doc.moveDown().text('Mainframe results');for(const [label,key] of [['Matched','matchedCount'],['Mismatched','mismatchedCount'],['Transaction only','transactionOnlyCount'],['Settlement only','settlementOnlyCount'],['Transaction amount','transactionAmount'],['Settlement amount','settlementAmount'],['Validated amount','validatedAmount'],['Discrepancy amount','discrepancyAmount']])doc.text(`${label}: ${s[key]??'Not available in current mainframe output'}`);doc.moveDown().text(`JES job ID: ${run.jobId??'Not available'}`).text(`JES status: ${run.jobStatus??'Not available'}`).text(`Return code: ${run.returnCode??'Not available'}`).text(`EOD decision: ${run.eodDecision??'Not available'}`);doc.moveDown().text('JES step evidence');for(const step of run.stepResults??[])doc.text(`${step.stepName??step.stage??'Step'} · ${step.status??'status unavailable'} · RC ${step.returnCode??'—'} · ${step.conditionCode??'condition unavailable'}`);doc.moveDown().text('Output datasets');for(const output of run.outputReferences??[])doc.text(`${output.dataset??output.name??'Dataset unavailable'} · ${output.state??output.status??'availability unavailable'}`);doc.moveDown().text('Diagnostics');for(const line of run.diagnostics??[])doc.text(`• ${line}`);doc.end();}));
app.get('/api/audit', requireOperator, asyncRoute(async(req,res)=>{const parsed=auditQuery.safeParse(req.query);if(!parsed.success)return res.status(400).json({code:'VALIDATION_ERROR',message:'Audit filter values are invalid.'});const q=parsed.data;const filter:Record<string,unknown>={};if(q.from||q.to)filter.timestamp={...(q.from?{$gte:new Date(q.from)}:{}),...(q.to?{$lte:new Date(q.to)}:{})};if(q.eventType)filter.eventType=q.eventType;if(q.outcome)filter.outcome=q.outcome;if(q.requestId)filter.requestId=q.requestId;const [items,total]=await Promise.all([AuditEvent.find(filter).select('timestamp createdAt requestId actorId actor eventType outcome resourceReference durationMs errorCategory errorMessage action runId organizationId').sort({timestamp:-1}).skip((q.page-1)*q.pageSize).limit(q.pageSize).lean(),AuditEvent.countDocuments(filter)]);return res.json({items,total,page:q.page,pageSize:q.pageSize,totalPages:Math.ceil(total/q.pageSize)});}));
app.use((error: unknown,req:Request,res:Response,next:NextFunction)=>{void next;const e=error as {name?:string;message?:string;code?:string};if(e.name==='MulterError')return res.status(413).json({code:'UPLOAD_REJECTED',message:e.code==='LIMIT_FILE_SIZE'?'File exceeds the configured upload size limit.':'Upload was rejected by a file limit.'});const requestId=(req as Request&{requestId?:string}).requestId;logStructured('error',{event:'api.unhandled_error',requestId,errorName:sanitizeText(e.name??'Error',60),errorMessage:sanitizeText(e.message??'Unhandled API error.')});return res.status(500).json({code:'INTERNAL_ERROR',message:'The request could not be completed.'});});
mongoose.connection.on('connected',()=>logStructured('info',{event:'mongodb.connected'}));
mongoose.connection.on('disconnected',()=>logStructured('warn',{event:'mongodb.disconnected'}));
mongoose.connection.on('error',(error:unknown)=>logStructured('error',{event:'mongodb.connection_error',errorName:sanitizeText((error as Error)?.name??'MongoError',60)}));
async function start(){logStructured('info',{event:'api.starting',port,environment:sanitizeText(process.env.NODE_ENV??'development',40)});const invalid:string[]=[];if(!Number.isInteger(port)||port<1||port>65535)invalid.push('PORT must be an integer from 1 to 65535');if(!Number.isInteger(maxBytes)||maxBytes<1)invalid.push('MAX_UPLOAD_BYTES must be a positive integer');if(process.env.MAINFRAME_ENDPOINT){try{const endpoint=new URL(process.env.MAINFRAME_ENDPOINT);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)invalid.push('MAINFRAME_ENDPOINT must be an HTTPS origin without credentials, query, or fragment');}catch{invalid.push('MAINFRAME_ENDPOINT must be a valid HTTPS URL');}}let timeout=45_000;try{timeout=resolveZoweTimeoutMs(process.env);}catch{invalid.push('ZOWE_CLI_TIMEOUT_MS must be an integer between 1000 and 60000');}if(process.env.MAINFRAME_ENABLED==='true'||process.env.MAINFRAME_AUTH_READY==='true')logStructured('warn',{event:'configuration.execution_flags',mainframeEnabled:process.env.MAINFRAME_ENABLED==='true',authorizationReady:process.env.MAINFRAME_AUTH_READY==='true',message:'Execution flags are set, but no execution adapter is configured; live execution remains unavailable.'});if(invalid.length){logStructured('error',{event:'configuration.invalid',issues:invalid});throw new Error('Invalid server configuration.');}logStructured('info',{event:'configuration.validated',mongodbConfigured:Boolean(process.env.MONGODB_URI),mainframeEndpointConfigured:Boolean(process.env.MAINFRAME_ENDPOINT),zoweProfile:'zosmf',zoweTimeoutMs:timeout,liveExecutionEnabled:false});await fs.mkdir(uploadRoot,{recursive:true});await cleanupStaging();setInterval(()=>void cleanupStaging(),60*60*1000).unref();if(process.env.MONGODB_URI){await mongoose.connect(process.env.MONGODB_URI);await markInterruptedDatasetOperations();await markInterruptedSmokeSubmissions();}else logStructured('warn',{event:'configuration.mongodb_missing',message:'MONGODB_URI is unset; persistence APIs require MongoDB.'});app.listen(port,()=>logStructured('info',{event:'api.listening',port}));}
void start().catch((error:unknown)=>{logStructured('error',{event:'api.start_failed',errorName:sanitizeText((error as Error)?.name??'Error',60),errorMessage:sanitizeText((error as Error)?.message??'Server startup failed.')});process.exitCode=1;});
