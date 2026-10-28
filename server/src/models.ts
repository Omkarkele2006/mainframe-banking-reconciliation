import mongoose, { Schema } from 'mongoose';
import type { RunStatus, TestProfile, ReconciliationSummary } from './types.js';

const organizationSchema = new Schema({ name: { type: String, required: true, trim: true, maxlength: 120 }, code: { type: String, required: true, uppercase: true, trim: true, maxlength: 20, unique: true }, active: { type: Boolean, default: true } }, { timestamps: true });
const runSchema = new Schema({ runId: { type: String, required: true, unique: true, index: true }, idempotencyKey: { type: String, unique: true, sparse: true, index: true }, actorId: String, stage: String, lastAuditedTransitionId: String, stageResults: { type: Schema.Types.Mixed, default: {} }, organization: { type: Schema.Types.ObjectId, ref: 'Organization', required: true }, organizationName: { type: String, required: true }, status: { type: String, enum: ['RECEIVED','PREFLIGHT','ALLOCATING','UPLOADING','SORTING','DUPLICATE_CHECK','VSAM_SETUP','RECONCILING','RETRIEVING_RESULTS','EOD_VALIDATING','REPORT_GENERATION','CLEANUP','READY_FOR_MAINFRAME','SUBMITTED','RUNNING','COMPLETED','COMPLETED_WITH_EXCEPTIONS','BUSINESS_EXCEPTION','FAILED','NOT_CONFIGURED','AWAITING_RECOVERY'], required: true }, profile: { type: String, enum: ['SMOKE','VOLUME_10K','NEGATIVE'], required: true }, inputs: { transaction: { uploadId:String, originalName: String, size: Number, sha256:String, recordCount: Number, valid: Boolean }, settlement: { uploadId:String, originalName: String, size: Number, sha256:String, recordCount: Number, valid: Boolean } }, summary: { type: Schema.Types.Mixed, default: {} }, jobId: String, jobStatus: String, returnCode: Number, stepResults: [Schema.Types.Mixed], eodDecision: String, diagnostics: [String], plan: Schema.Types.Mixed, datasetManifest: [Schema.Types.Mixed], stateTransitions: [Schema.Types.Mixed], outputReferences: [Schema.Types.Mixed], cleanupStatus: { type: Schema.Types.Mixed, default: { state:'NOT_STARTED', warnings:[] } }, createdAt: { type: Date, default: Date.now }, completedAt: Date, errorCode: String, reportReference: String }, { timestamps: true });
const reportSchema = new Schema({ run: { type: Schema.Types.ObjectId, ref: 'Run', required: true, unique: true }, generatedAt: { type: Date, default: Date.now }, formatVersion: { type: String, default: '1.0' } }, { timestamps: true });
const uploadSchema = new Schema({ uploadId: { type: String, required: true, unique: true }, organization: { type: Schema.Types.ObjectId, ref: 'Organization', required: true }, kind: { type: String, enum: ['transaction','settlement'], required: true }, originalName: { type: String, required: true }, size: { type: Number, required: true }, sha256: { type: String, required: true }, recordCount: { type: Number, required: true }, valid: { type: Boolean, required: true }, validationErrors: [String], preview: [String], stagedPath: { type: String, required: true }, expiresAt: { type: Date, required: true, expires: 0 } }, { timestamps: true });
const planSchema = new Schema({ planId:{type:String,required:true,unique:true}, organization:{type:Schema.Types.ObjectId,ref:'Organization',required:true}, transactionUploadId:{type:String,required:true}, settlementUploadId:{type:String,required:true}, profile:{type:String,required:true}, plan:{type:Schema.Types.Mixed,required:true}, expiresAt:{type:Date,required:true,expires:0} },{timestamps:true});
const uploadVerificationSchema = new Schema({
  operationId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  organizationName: { type: String, required: true }, actorId: { type: String, required: true },
  transaction: { type: Schema.Types.Mixed, required: true }, settlement: { type: Schema.Types.Mixed, required: true },
  runQualifier: { type: String, required: true }, datasets: { type: [Schema.Types.Mixed], required: true },
  status: { type: String, enum: ['PREPARED','RUNNING','VERIFIED','VERIFIED_WITH_CLEANUP_WARNING','FAILED','CLEANUP_FAILED'], required: true, index: true },
  stage: { type: String, required: true }, stageResults: { type: Schema.Types.Mixed, default: {} },
  errorCategory: String, errorMessage: String,
}, { timestamps: true, minimize: false });
const jobEvidenceSchema = new Schema({
  runId: { type: String, required: true, index: true },
  jobId: { type: String, required: true, index: true },
  status: { type: String, required: true },
  returnCode: { type: Number, default: null },
  conditionCode: String,
  retrievedAt: { type: Date, required: true, default: Date.now },
  spoolText: { type: String, maxlength: 1048576 },
  spoolTruncated: { type: Boolean, default: false },
}, { timestamps: true });
jobEvidenceSchema.index({ runId: 1, jobId: 1 }, { unique: true });
const smokeJobOperationSchema = new Schema({
  operationId: { type: String, required: true, unique: true, index: true },
  actorId: { type: String, required: true, index: true },
  idempotencyKey: { type: String, required: true },
  activeLock: { type: String, unique: true, sparse: true, index: true },
  template: { type: String, enum: ['NOOP_SMOKE'], required: true },
  jobName: { type: String, required: true },
  state: { type: String, enum: ['PREPARED','SUBMITTING','SUBMISSION_UNCERTAIN','SUBMITTED','RUNNING','UNRESOLVED','COMPLETED','FAILED'], required: true, index: true },
  jobId: { type: String, index: true },
  jobStatus: String,
  returnCode: { type: Number, default: null },
  conditionCode: String,
  createdAt: { type: Date, default: Date.now, index: true },
  submittedAt: Date,
  lastCheckedAt: Date,
  completedAt: Date,
  spoolText: { type: String, maxlength: 1048576 },
  spoolTruncated: { type: Boolean, default: false },
  spoolRetrievedAt: Date,
  errorCategory: String,
  errorMessage: String,
}, { timestamps: true, minimize: false });
smokeJobOperationSchema.index({ actorId: 1, idempotencyKey: 1 }, { unique: true });
const bankingPreflightSchema = new Schema({
  operationId:{type:String,required:true,unique:true,index:true}, runId:{type:String,required:true,unique:true,index:true},
  actorId:{type:String,required:true,index:true}, idempotencyKey:{type:String,required:true}, activeLock:{type:String,unique:true,sparse:true,index:true},
  organizationId:{type:Schema.Types.ObjectId,ref:'Organization',required:true,index:true}, organizationName:{type:String,required:true},
  state:{type:String,enum:['PREPARED','PREFLIGHT','ALLOCATING','UPLOADING','SORTING','VERIFYING_OUTPUTS','READY_FOR_RECONCILIATION','DUPLICATES_FOUND','RECONCILIATION_PREFLIGHT','VSAM_COBOL_RUNNING','RECONCILIATION_BLOCKED','RECONCILIATION_FAILED','RECONCILIATION_UNRESOLVED','RECONCILIATION_COMPLETED','RECONCILIATION_COMPLETED_WITH_EXCEPTIONS','FAILED','SUBMISSION_UNCERTAIN','UNRESOLVED'],required:true,index:true},
  stage:{type:String,required:true}, profile:{type:String,enum:['SMOKE','VOLUME_10K','NEGATIVE'],required:true},
  inputs:{type:Schema.Types.Mixed,required:true}, runQualifier:{type:String,required:true}, plan:{type:Schema.Types.Mixed,required:true}, jcl:{type:String,required:true}, reconciliationJcl:String,
  datasets:{type:[Schema.Types.Mixed],required:true}, stageResults:{type:Schema.Types.Mixed,default:{}},
  jobId:{type:String,index:true},jobStatus:String,returnCode:{type:Number,default:null},conditionCode:String,spoolText:{type:String,maxlength:1048576},
  submittedAt:Date,lastCheckedAt:Date,completedAt:Date,errorCategory:String,errorMessage:String,createdAt:{type:Date,default:Date.now,index:true},updatedAt:Date,
},{timestamps:true,minimize:false});
bankingPreflightSchema.index({actorId:1,idempotencyKey:1},{unique:true});
const datasetOwnershipSchema = new Schema({
  dataset: { type: String, required: true, unique: true, uppercase: true, index: true },
  ownerActorId: { type: String, required: true, index: true },
  createdByOperationId: { type: String, required: true, unique: true },
  state: { type: String, enum: ['PLANNED','CREATING','CREATED','ACTIVE','UPLOADING','DELETING','DELETED','UNCERTAIN','RUN_MANAGED','RUN_MANAGED_UNCERTAIN'], required: true, index: true },
  attributes: { type: Schema.Types.Mixed, required: true },
  allocation: { type: Schema.Types.Mixed, required: true },
  lastOperationId: String,
  lastErrorCategory: String,
  createdAtRemote: Date,
  deletedAtRemote: Date,
}, { timestamps: true, minimize: false });
const datasetOperationSchema = new Schema({
  operationId: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true },
  actorId: { type: String, required: true },
  action: { type: String, enum: ['CREATE','UPLOAD','REPLACE','DELETE','RECOVER'], required: true },
  dataset: { type: String, required: true, uppercase: true, index: true },
  ownershipId: { type: Schema.Types.ObjectId, ref: 'DatasetOwnership' },
  status: { type: String, enum: ['PREPARED','RUNNING','SUCCEEDED','FAILED','UNCERTAIN','REJECTED'], required: true, index: true },
  evidence: { type: Schema.Types.Mixed, default: {} },
  errorCategory: String,
  errorMessage: String,
}, { timestamps: true, minimize: false });
datasetOperationSchema.index({ actorId: 1, idempotencyKey: 1 }, { unique: true });
const auditSchema = new Schema({
  timestamp: { type: Date, required: true, default: Date.now, index: true },
  requestId: { type: String, index: true },
  actorId: { type: String, default: 'anonymous' },
  eventType: { type: String, required: true, index: true },
  outcome: { type: String, required: true, index: true },
  resourceReference: String,
  durationMs: Number,
  errorCategory: String,
  errorMessage: String,
  // Legacy compatibility fields; new events do not store IP addresses or arbitrary details.
  action: { type: String, required: true },
  runId: String,
  organizationId: String,
  actor: { type: String, default: 'system' },
  details: { type: Schema.Types.Mixed, default: {} },
  ip: String,
}, { timestamps: true });
auditSchema.index({ timestamp: -1 });
auditSchema.index({ eventType: 1, timestamp: -1 });
auditSchema.index({ outcome: 1, timestamp: -1 });
auditSchema.index({ requestId: 1 });
export const Organization = mongoose.models.Organization ?? mongoose.model('Organization', organizationSchema);
export const Run = mongoose.models.Run ?? mongoose.model('Run', runSchema);
export const Report = mongoose.models.Report ?? mongoose.model('Report', reportSchema);
export const Upload = mongoose.models.Upload ?? mongoose.model('Upload', uploadSchema);
export const ExecutionPlan = mongoose.models.ExecutionPlan ?? mongoose.model('ExecutionPlan', planSchema);
export const UploadVerification = mongoose.models.UploadVerification ?? mongoose.model('UploadVerification', uploadVerificationSchema);
export const JobEvidence = mongoose.models.JobEvidence ?? mongoose.model('JobEvidence', jobEvidenceSchema);
export const SmokeJobOperation = mongoose.models.SmokeJobOperation ?? mongoose.model('SmokeJobOperation', smokeJobOperationSchema);
export const BankingPreflight = mongoose.models.BankingPreflight ?? mongoose.model('BankingPreflight', bankingPreflightSchema);
export const DatasetOwnership = mongoose.models.DatasetOwnership ?? mongoose.model('DatasetOwnership', datasetOwnershipSchema);
export const DatasetOperation = mongoose.models.DatasetOperation ?? mongoose.model('DatasetOperation', datasetOperationSchema);
export const AuditEvent = mongoose.models.AuditEvent ?? mongoose.model('AuditEvent', auditSchema);
export type RunDocument = mongoose.HydratedDocument<{runId:string; organization: mongoose.Types.ObjectId; organizationName:string; status:RunStatus; profile:TestProfile; inputs:unknown; summary:ReconciliationSummary; jobId?:string; jobStatus?:string; returnCode?:number; eodDecision?:string; diagnostics?:string[]; errorCode?:string; completedAt?:Date}>;
