import mongoose, { Schema } from 'mongoose';
import type { RunStatus, TestProfile, ReconciliationSummary } from './types.js';

const organizationSchema = new Schema({ name: { type: String, required: true, trim: true, maxlength: 120 }, code: { type: String, required: true, uppercase: true, trim: true, maxlength: 20, unique: true }, active: { type: Boolean, default: true } }, { timestamps: true });
const runSchema = new Schema({ runId: { type: String, required: true, unique: true, index: true }, idempotencyKey: { type: String, unique: true, sparse: true, index: true }, organization: { type: Schema.Types.ObjectId, ref: 'Organization', required: true }, organizationName: { type: String, required: true }, status: { type: String, enum: ['RECEIVED','PREFLIGHT','ALLOCATING','UPLOADING','SORTING','DUPLICATE_CHECK','VSAM_SETUP','RECONCILING','RETRIEVING_RESULTS','EOD_VALIDATING','REPORT_GENERATION','CLEANUP','READY_FOR_MAINFRAME','SUBMITTED','RUNNING','COMPLETED','COMPLETED_WITH_EXCEPTIONS','BUSINESS_EXCEPTION','FAILED','NOT_CONFIGURED','AWAITING_RECOVERY'], required: true }, profile: { type: String, enum: ['SMOKE','VOLUME_10K','NEGATIVE'], required: true }, inputs: { transaction: { uploadId:String, originalName: String, size: Number, sha256:String, recordCount: Number, valid: Boolean }, settlement: { uploadId:String, originalName: String, size: Number, sha256:String, recordCount: Number, valid: Boolean } }, summary: { type: Schema.Types.Mixed, default: {} }, jobId: String, jobStatus: String, returnCode: Number, stepResults: [Schema.Types.Mixed], eodDecision: String, diagnostics: [String], plan: Schema.Types.Mixed, datasetManifest: [Schema.Types.Mixed], stateTransitions: [Schema.Types.Mixed], outputReferences: [Schema.Types.Mixed], cleanupStatus: { type: Schema.Types.Mixed, default: { state:'NOT_STARTED', warnings:[] } }, createdAt: { type: Date, default: Date.now }, completedAt: Date, errorCode: String, reportReference: String }, { timestamps: true });
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
export const AuditEvent = mongoose.models.AuditEvent ?? mongoose.model('AuditEvent', auditSchema);
export type RunDocument = mongoose.HydratedDocument<{runId:string; organization: mongoose.Types.ObjectId; organizationName:string; status:RunStatus; profile:TestProfile; inputs:unknown; summary:ReconciliationSummary; jobId?:string; jobStatus?:string; returnCode?:number; eodDecision?:string; diagnostics?:string[]; errorCode?:string; completedAt?:Date}>;
