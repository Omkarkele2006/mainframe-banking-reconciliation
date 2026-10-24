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
import { AuditEvent, ExecutionPlan, Organization, Report, Run, Upload, UploadVerification } from './models.js';
import { readiness, mainframeAdapter } from './mainframe.js';
import { auditQuery, historyQuery, organizationInput, previewInput, runInput, uploadVerificationPreviewInput, uploadVerificationStartInput, validateFixedWidthFile } from './validation.js';
import { resolveZoweTimeoutMs, runZoweConnectionTest, testZoweProfile } from './zoweCli.js';
import { logStructured, requestObservability, sanitizeText } from './observability.js';
import { buildExecutionPlanPreview, createRunId, MAX_UPLOAD_BYTES } from './executionPlan.js';
import { authConfiguration, authConfigured, authSessionView, createOperatorSession, requireOperator, revokeOperatorSession, sessionCookie, sessionMiddleware, clearSessionCookie, verifyOperatorPassword, type AuthRequest } from './operatorAuth.js';
import { buildUploadVerificationPlan, executeUploadVerification, retryUploadVerificationCleanup, safeSmokeErrorMessage, safeUploadVerificationResponse, validateSmokeConfiguration, type SmokeInput, type UploadVerificationRecord } from './uploadVerification.js';
import { createZoweUploadAdapter } from './zoweUploadAdapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(projectRoot, '.env') });
const app = express();
const port = Number(process.env.PORT ?? 4000);
const uploadRoot = path.resolve(projectRoot, process.env.UPLOAD_DIR ?? 'server/.uploads');
const maxBytes = Math.min(Number(process.env.MAX_UPLOAD_BYTES ?? MAX_UPLOAD_BYTES), MAX_UPLOAD_BYTES);
type ExportRun = { runId:string; organizationName:string; status:string; profile:string; createdAt:Date; completedAt?:Date; inputs:{transaction?:{originalName?:string;recordCount?:number};settlement?:{originalName?:string;recordCount?:number}}; summary:Record<string,unknown>; jobId?:string; jobStatus?:string; returnCode?:number; eodDecision?:string; diagnostics?:string[]; errorCode?:string };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1 }, fileFilter: (_req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() === '.txt') });
app.disable('x-powered-by');
app.use(helmet());
app.use('/api', requestObservability({ audit: (record) => AuditEvent.create(record) }));
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((v) => v.trim());
app.use(cors({ origin: allowedOrigins, credentials: true, methods: ['GET','POST','PATCH','OPTIONS'], allowedHeaders: ['Content-Type','X-CSRF-Token'] }));
app.use(express.json({ limit: '32kb' }));
app.use('/api', sessionMiddleware);
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
const zosmfConnectionLimit = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many connection-test attempts. Wait 15 minutes and try again.' } });
const operatorLoginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Wait 15 minutes and try again.' } });
const uploadVerificationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 3, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many mainframe file-transfer tests. Wait 15 minutes and try again.' } });
const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req,res).catch(next); };
const audit = (action: string, outcome: string, details: Record<string, unknown> = {}, runId?: string, organizationId?: string, req?: Request) => {
  const requestId = resRequestId(req);
  return AuditEvent.create({ timestamp: new Date(), requestId, actorId: sanitizeText((req as (Request & { actorId?: string }) | undefined)?.actorId ?? 'anonymous',120), eventType: sanitizeText(action, 80), outcome: sanitizeText(outcome, 40), resourceReference: runId ?? organizationId ?? 'api', durationMs: 0, action: sanitizeText(action, 100), runId, organizationId, details: sanitizeAuditDetails(details) });
};
function resRequestId(req?: Request) { return (req as (Request & { requestId?: string }) | undefined)?.requestId; }
function sanitizeAuditDetails(details: Record<string, unknown>) { const safe: Record<string, unknown> = {}; for (const [key,value] of Object.entries(details)) { if (/password|token|authorization|cookie|secret|jcl|spool|payload|body/i.test(key)) continue; if (typeof value === 'string') safe[sanitizeText(key,60)] = sanitizeText(value,200); else if (typeof value === 'number' || typeof value === 'boolean') safe[sanitizeText(key,60)] = value; } return safe; }
async function cleanupStaging() {
  try {
    const entries=await fs.readdir(uploadRoot,{withFileTypes:true});
    for(const entry of entries){if(!entry.isFile()||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:txt|out)$/i.test(entry.name))continue;const fullPath=path.resolve(uploadRoot,entry.name);if(path.dirname(fullPath)!==uploadRoot)continue;const stat=await fs.stat(fullPath);const retention=entry.name.toLowerCase().endsWith('.out')?60*60*1000:24*60*60*1000;if(Date.now()-stat.mtimeMs>retention)await fs.unlink(fullPath);}
  } catch(error) { logStructured('warn',{event:'upload.staging_cleanup_failed',errorName:sanitizeText((error as Error).name??'Error',60)}); }
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
app.get('/api/readiness', (_req,res) => { const state = readiness(); return res.json({ ...state, connectionTestConfigured: true, connectionTest: 'NOT_TESTED', liveExecutionEnabled: false, message: 'A read-only Zowe CLI profile and dataset check is available. CLI and profile availability are checked when tested. Live execution remains disabled.' }); });
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
  if(state.liveExecutionEnabled&&(!idempotencyKey||!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)))return res.status(400).json({code:'IDEMPOTENCY_KEY_REQUIRED',message:'A unique idempotency key is required before any live submission.'});
  if(idempotencyKey&&await Run.exists({idempotencyKey}))return res.status(409).json({code:'DUPLICATE_SUBMISSION',message:'This run request has already been recorded. Inspect its persisted status before retrying.'});
  const runId=parsed.data.planId;
  const planData=storedPlan.plan as {datasets?:Array<{name:string;purpose:string;state:string}>;cleanupManifest?:unknown};
  const run=await Run.create({runId,idempotencyKey,organization:org._id,organizationName:org.name,status:state.liveExecutionEnabled?'PREFLIGHT':'NOT_CONFIGURED',profile,inputs:{transaction:{uploadId:txn.uploadId,originalName:txn.originalName,size:txn.size,sha256:txn.sha256,recordCount:txn.recordCount,valid:txn.valid},settlement:{uploadId:set.uploadId,originalName:set.originalName,size:set.size,sha256:set.sha256,recordCount:set.recordCount,valid:set.valid}},plan:storedPlan.plan,datasetManifest:(planData.datasets??[]).map((dataset)=>({name:dataset.name,purpose:dataset.purpose,state:'PLANNED_NOT_CREATED'})),stateTransitions:[{status:state.liveExecutionEnabled?'PREFLIGHT':'NOT_CONFIGURED',at:new Date(),actorId:(req as AuthRequest).actorId}],summary:{},diagnostics:state.liveExecutionEnabled?[]:['Execution adapter is not configured. No z/OS mutation was performed.'],errorCode:state.liveExecutionEnabled?undefined:'MAINFRAME_NOT_CONFIGURED'});
  await Report.create({run:run._id}); await audit('RUN_REQUESTED',run.status,{profile},runId,String(org._id),req);
  if(!state.liveExecutionEnabled) return res.status(503).json({code:'MAINFRAME_NOT_CONFIGURED',message:'Uploads passed file-contract checks, but mainframe execution is not configured. No job was submitted.',runId,status:run.status});
  try { const submission=await mainframeAdapter.submit({runId,transactionPath:txn.stagedPath,settlementPath:set.stagedPath,profile}); run.status='SUBMITTED';run.jobId=submission.jobId;await run.save(); await audit('MAINFRAME_SUBMITTED','SUCCESS',{},runId,String(org._id),req); return res.status(202).json({runId,status:run.status,jobId:submission.jobId}); }
  catch { run.status='FAILED';run.errorCode='MAINFRAME_SUBMISSION_FAILED';run.diagnostics=['Mainframe submission failed.'];await run.save(); await audit('MAINFRAME_SUBMITTED','FAILED',{},runId,String(org._id),req); return res.status(502).json({code:'MAINFRAME_SUBMISSION_FAILED',message:'Mainframe submission failed; no successful run was recorded.',runId,status:run.status}); }
}));
app.get('/api/runs', requireOperator, asyncRoute(async (req,res) => {
  const parsed=historyQuery.safeParse(req.query);if(!parsed.success)return res.status(400).json({code:'VALIDATION_ERROR',issues:parsed.error.issues}); const q=parsed.data;
  const filter:Record<string,unknown>={};if(q.status)filter.status=q.status;if(q.search)filter.$or=[{runId:{$regex:q.search,$options:'i'}},{organizationName:{$regex:q.search,$options:'i'}},{'inputs.transaction.originalName':{$regex:q.search,$options:'i'}},{'inputs.settlement.originalName':{$regex:q.search,$options:'i'}}];
  const [items,total]=await Promise.all([Run.find(filter).sort({[q.sort]:q.order==='asc'?1:-1}).skip((q.page-1)*q.pageSize).limit(q.pageSize).lean(),Run.countDocuments(filter)]);
  return res.json({items,total,page:q.page,pageSize:q.pageSize,totalPages:Math.ceil(total/q.pageSize)});
}));
app.get('/api/runs/:runId', requireOperator, asyncRoute(async (req,res) => {const run=await Run.findOne({runId:req.params.runId}).populate('organization','name code').lean();return run?res.json(run):res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});}));
app.get('/api/runs/:runId/report', requireOperator, asyncRoute(async(req,res)=>{const run=await Run.findOne({runId:req.params.runId}).lean().exec() as unknown as ExportRun|null;if(!run)return res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});return res.json({organizationName:run.organizationName,runId:run.runId,status:run.status,profile:run.profile,submittedAt:run.createdAt,completedAt:run.completedAt??null,inputs:run.inputs,summary:run.summary,jobId:run.jobId??null,jobStatus:run.jobStatus??null,returnCode:run.returnCode??null,eodDecision:run.eodDecision??'NOT_AVAILABLE',diagnostics:run.diagnostics??[],errorCode:run.errorCode??null});}));
app.get('/api/runs/:runId/export.csv', requireOperator, asyncRoute(async(req,res)=>{const run=await Run.findOne({runId:req.params.runId}).lean().exec() as unknown as ExportRun|null;if(!run)return res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});const s=run.summary;const rows=[['Organization',run.organizationName],['Run ID',run.runId],['Status',run.status],['Profile',run.profile],['Submitted',run.createdAt.toISOString()],['Transaction input records',String(run.inputs.transaction?.recordCount??'')],['Settlement input records',String(run.inputs.settlement?.recordCount??'')],['Matched',String(s.matchedCount??'Not available in current mainframe output')],['Mismatched',String(s.mismatchedCount??'Not available in current mainframe output')],['Transaction only',String(s.transactionOnlyCount??'Not available in current mainframe output')],['Settlement only',String(s.settlementOnlyCount??'Not available in current mainframe output')],['Transaction amount',String(s.transactionAmount??'Not available in current mainframe output')],['Settlement amount',String(s.settlementAmount??'Not available in current mainframe output')],['Validated amount',String(s.validatedAmount??'Not available in current mainframe output')],['Discrepancy amount',String(s.discrepancyAmount??'Not available in current mainframe output')],['JES job ID',run.jobId??'Not available'],['Return code',String(run.returnCode??'Not available')],['EOD publication decision',run.eodDecision??'Not available']];res.type('text/csv').attachment(`${run.runId}.csv`).send(rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n'));}));
app.get('/api/runs/:runId/export.pdf', requireOperator, asyncRoute(async(req,res)=>{const run=await Run.findOne({runId:req.params.runId}).lean().exec() as unknown as ExportRun|null;if(!run)return res.status(404).json({code:'RUN_NOT_FOUND',message:'Run not found.'});res.type('application/pdf').attachment(`${run.runId}.pdf`);const doc=new PDFDocument({margin:56});doc.pipe(res);doc.fontSize(20).text('Reconciliation run report');doc.moveDown().fontSize(11).text(`Organization: ${run.organizationName}`).text(`Run ID: ${run.runId}`).text(`Status: ${run.status}`).text(`Profile: ${run.profile}`).text(`Submitted: ${run.createdAt.toISOString()}`).text(`Completed: ${run.completedAt?.toISOString()??'Not available'}`);doc.moveDown().text('Input files');const inputs=run.inputs;doc.text(`Transactions: ${inputs.transaction?.originalName??'—'} (${inputs.transaction?.recordCount??'—'} records)`).text(`Settlements: ${inputs.settlement?.originalName??'—'} (${inputs.settlement?.recordCount??'—'} records)`);const s=run.summary;doc.moveDown().text('Mainframe results');for(const [label,key] of [['Matched','matchedCount'],['Mismatched','mismatchedCount'],['Transaction only','transactionOnlyCount'],['Settlement only','settlementOnlyCount'],['Transaction amount','transactionAmount'],['Settlement amount','settlementAmount'],['Validated amount','validatedAmount'],['Discrepancy amount','discrepancyAmount']])doc.text(`${label}: ${s[key]??'Not available in current mainframe output'}`);doc.moveDown().text(`JES job ID: ${run.jobId??'Not available'}`).text(`Return code: ${run.returnCode??'Not available'}`).text(`EOD decision: ${run.eodDecision??'Not available'}`);doc.moveDown().text('Diagnostics');for(const line of run.diagnostics??[])doc.text(`• ${line}`);doc.end();}));
app.get('/api/audit', requireOperator, asyncRoute(async(req,res)=>{const parsed=auditQuery.safeParse(req.query);if(!parsed.success)return res.status(400).json({code:'VALIDATION_ERROR',message:'Audit filter values are invalid.'});const q=parsed.data;const filter:Record<string,unknown>={};if(q.from||q.to)filter.timestamp={...(q.from?{$gte:new Date(q.from)}:{}),...(q.to?{$lte:new Date(q.to)}:{})};if(q.eventType)filter.eventType=q.eventType;if(q.outcome)filter.outcome=q.outcome;if(q.requestId)filter.requestId=q.requestId;const [items,total]=await Promise.all([AuditEvent.find(filter).select('timestamp createdAt requestId actorId actor eventType outcome resourceReference durationMs errorCategory errorMessage action runId organizationId').sort({timestamp:-1}).skip((q.page-1)*q.pageSize).limit(q.pageSize).lean(),AuditEvent.countDocuments(filter)]);return res.json({items,total,page:q.page,pageSize:q.pageSize,totalPages:Math.ceil(total/q.pageSize)});}));
app.use((error: unknown,req:Request,res:Response,next:NextFunction)=>{void next;const e=error as {name?:string;message?:string;code?:string};if(e.name==='MulterError')return res.status(413).json({code:'UPLOAD_REJECTED',message:e.code==='LIMIT_FILE_SIZE'?'File exceeds the configured upload size limit.':'Upload was rejected by a file limit.'});const requestId=(req as Request&{requestId?:string}).requestId;logStructured('error',{event:'api.unhandled_error',requestId,errorName:sanitizeText(e.name??'Error',60),errorMessage:sanitizeText(e.message??'Unhandled API error.')});return res.status(500).json({code:'INTERNAL_ERROR',message:'The request could not be completed.'});});
mongoose.connection.on('connected',()=>logStructured('info',{event:'mongodb.connected'}));
mongoose.connection.on('disconnected',()=>logStructured('warn',{event:'mongodb.disconnected'}));
mongoose.connection.on('error',(error:unknown)=>logStructured('error',{event:'mongodb.connection_error',errorName:sanitizeText((error as Error)?.name??'MongoError',60)}));
async function start(){logStructured('info',{event:'api.starting',port,environment:sanitizeText(process.env.NODE_ENV??'development',40)});const invalid:string[]=[];if(!Number.isInteger(port)||port<1||port>65535)invalid.push('PORT must be an integer from 1 to 65535');if(!Number.isInteger(maxBytes)||maxBytes<1)invalid.push('MAX_UPLOAD_BYTES must be a positive integer');if(process.env.MAINFRAME_ENDPOINT){try{const endpoint=new URL(process.env.MAINFRAME_ENDPOINT);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)invalid.push('MAINFRAME_ENDPOINT must be an HTTPS origin without credentials, query, or fragment');}catch{invalid.push('MAINFRAME_ENDPOINT must be a valid HTTPS URL');}}let timeout=45_000;try{timeout=resolveZoweTimeoutMs(process.env);}catch{invalid.push('ZOWE_CLI_TIMEOUT_MS must be an integer between 1000 and 60000');}if(process.env.MAINFRAME_ENABLED==='true'||process.env.MAINFRAME_AUTH_READY==='true')logStructured('warn',{event:'configuration.execution_flags',mainframeEnabled:process.env.MAINFRAME_ENABLED==='true',authorizationReady:process.env.MAINFRAME_AUTH_READY==='true',message:'Execution flags are set, but no execution adapter is configured; live execution remains unavailable.'});if(invalid.length){logStructured('error',{event:'configuration.invalid',issues:invalid});throw new Error('Invalid server configuration.');}logStructured('info',{event:'configuration.validated',mongodbConfigured:Boolean(process.env.MONGODB_URI),mainframeEndpointConfigured:Boolean(process.env.MAINFRAME_ENDPOINT),zoweProfile:'zosmf',zoweTimeoutMs:timeout,liveExecutionEnabled:false});await fs.mkdir(uploadRoot,{recursive:true});await cleanupStaging();setInterval(()=>void cleanupStaging(),60*60*1000).unref();if(process.env.MONGODB_URI){await mongoose.connect(process.env.MONGODB_URI);}else logStructured('warn',{event:'configuration.mongodb_missing',message:'MONGODB_URI is unset; persistence APIs require MongoDB.'});app.listen(port,()=>logStructured('info',{event:'api.listening',port}));}
void start().catch((error:unknown)=>{logStructured('error',{event:'api.start_failed',errorName:sanitizeText((error as Error)?.name??'Error',60),errorMessage:sanitizeText((error as Error)?.message??'Server startup failed.')});process.exitCode=1;});
