import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSuccessfulJesJob, buildRunExecutionPlan, countConsistencyError, countDownloadedRecords, createDatasetToken, createRunId, generatePreflightJcl, generateReconciliationJcl, parseCobolCounts, type CobolCounts, type MainframePlanConfig, type RunExecutionPlan } from './executionPlan.js';
import { assertRunScopedJclContract, type RemoteJobStatus } from './reconciliationOrchestrator.js';
import { validateDatasetUpload, writeTransferCopy, sameRecords } from './datasetLifecycle.js';
import { normalizeFixedWidthRecords, safeSmokeErrorMessage, type DatasetAttributes } from './uploadVerification.js';
import { sanitizeText } from './observability.js';

export type PreflightState = 'PREPARED'|'PREFLIGHT'|'ALLOCATING'|'UPLOADING'|'SORTING'|'VERIFYING_OUTPUTS'|'READY_FOR_RECONCILIATION'|'DUPLICATES_FOUND'|'RECONCILIATION_PREFLIGHT'|'VSAM_COBOL_RUNNING'|'RECONCILIATION_BLOCKED'|'RECONCILIATION_FAILED'|'RECONCILIATION_UNRESOLVED'|'RECONCILIATION_COMPLETED'|'RECONCILIATION_COMPLETED_WITH_EXCEPTIONS'|'FAILED'|'SUBMISSION_UNCERTAIN'|'UNRESOLVED';
export type PreflightDatasetRole = 'TXNIN'|'SETIN'|'TXNSORT'|'SETSORT'|'DUPES'|'SETTLE'|'SETTLE_DATA'|'SETTLE_INDEX'|'MATCHOUT'|'MISMOUT'|'TXNMISS'|'SETMISS';
export type PreflightDataset = { name:string; role:PreflightDatasetRole; state:'PLANNED'|'CREATING'|'CREATED'|'UPLOADING'|'ACTIVE'|'UNCERTAIN'; attributes?:DatasetAttributes|Record<string,unknown>; recordCount?:number; errorCategory?:string };
export type PreflightInput = { uploadId:string; originalName:string; size:number; sha256:string; recordCount:number; valid:boolean; stagedPath:string };
export type BankingPreflight = {
  operationId:string; runId:string; actorId:string; idempotencyKey:string; activeLock?:string; organizationId:string; organizationName:string;
  state:PreflightState; stage:string; profile:'SMOKE'|'VOLUME_10K'|'NEGATIVE'; inputs:{transaction:PreflightInput;settlement:PreflightInput};
  runQualifier:string; plan:RunExecutionPlan; jcl:string; reconciliationJcl?:string; datasets:PreflightDataset[]; stageResults:Record<string,unknown>;
  jobId?:string; jobStatus?:string; returnCode?:number|null; conditionCode?:string; spoolText?:string; submittedAt?:Date; lastCheckedAt?:Date; completedAt?:Date;
  errorCategory?:string; errorMessage?:string; createdAt:Date; updatedAt?:Date;
};
export type PreflightRemote = {
  attributes(dataset:string):Promise<DatasetAttributes>;
  verifyLoadModule?(library:string,member:string):Promise<{verified:boolean;evidence?:string;message?:string}>;
  create(dataset:string,primaryTracks:number,secondaryTracks:number):Promise<unknown>;
  upload(dataset:string,localPath:string):Promise<void>;
  download(dataset:string,localPath:string):Promise<void>;
  submitJcl(localPath:string):Promise<{jobId:string}>;
  jobStatus(jobId:string):Promise<RemoteJobStatus>;
  jobSpool(jobId:string):Promise<string>;
};
export type PreflightDependencies = {
  env:NodeJS.ProcessEnv; stagingRoot:string; remote:PreflightRemote;
  persist:(operation:BankingPreflight)=>Promise<void>;
  ownership:(operation:BankingPreflight,dataset:PreflightDataset,state:PreflightDataset['state'],errorCategory?:string)=>Promise<void>;
  readiness:()=>Promise<{state:string;message:string}>;
  now?:()=>Date; sleep?:(ms:number)=>Promise<void>; pollAttempts?:number; pollIntervalMs?:number;
};
const DATASET_ROLES = ['TXNIN','SETIN','TXNSORT','SETSORT','DUPES'] as const;
const TERMINAL = new Set<PreflightState>(['READY_FOR_RECONCILIATION','DUPLICATES_FOUND','RECONCILIATION_BLOCKED','RECONCILIATION_FAILED','RECONCILIATION_UNRESOLVED','RECONCILIATION_COMPLETED','RECONCILIATION_COMPLETED_WITH_EXCEPTIONS','FAILED','SUBMISSION_UNCERTAIN','UNRESOLVED']);
const JOB_ID=/^(?:JOB|STC|TSU)\d{1,8}$/i;

function fail(message:string,code:string):never { throw Object.assign(new Error(message),{code}); }
function errorCode(error:unknown):string { const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z0-9_]{1,60}$/.test(code)?code:'PREFLIGHT_FAILED'; }
function safeFailure(error:unknown){const code=errorCode(error);const messages:Record<string,string>={ENOENT:'A staged input or required local file is unavailable.',STAGED_INPUT_CHANGED:'A staged file no longer matches its saved size, hash, or record contract.',STAGED_INPUT_INVALID:'A staged file does not satisfy the fixed-width record contract.',DATASET_NOT_FOUND:'A required run dataset was not found.',DATASET_COLLISION:'A run-specific target already exists; no existing dataset was overwritten.',DATASET_ATTRIBUTES_MISMATCH:'A run-specific dataset did not verify as PS/FB/LRECL=38.',READBACK_COUNT_MISMATCH:'Remote record count did not match the validated or generated output.',READBACK_CONTENT_MISMATCH:'Remote input readback differs from the original validated records.',JES_SPOOL_MISSING:'The completed JES job did not return usable spool evidence.',JES_STEP_EVIDENCE_MISSING:'JES spool did not provide the required preflight step return codes.',JES_NONZERO_RETURN_CODE:'The preflight job failed a technical return-code gate.',PREFLIGHT_TIMEOUT:'The bounded JES polling window elapsed; inspect this operation and do not resubmit.',TIMEOUT:'A Zowe command timed out. Inspect saved operation state before any further action.',ZOWE_TIMEOUT:'A Zowe command timed out. Inspect saved operation state before any further action.',AUTHENTICATION:'The local zosmf profile could not authenticate under the API process account.',AUTHORIZATION:'The local zosmf profile is not authorized for the requested operation.',NETWORK:'The z/OSMF endpoint could not be reached; check the local network and profile.',TLS:'The Zowe CLI reported a TLS error; inspect the local profile settings without disabling verification.',CLI_UNAVAILABLE:'Zowe CLI is unavailable to the API process.',ZOWE_NOT_READY:'The read-only Zowe connection or dataset-access check failed.',SUBMISSION_UNCERTAIN:'JES submission was invoked but no confirmed job identity was returned; do not resubmit.',OUTPUT_INVALID:'A sorted or duplicate output failed record validation.',PREFLIGHT_EVIDENCE_INVALID:'Saved preflight state does not prove RC 0, successful sort steps, sorted outputs and zero settlement duplicates.',LOAD_MODULE_UNVERIFIED:'The configured load module was not positively confirmed as a member of the configured load library.',RECONCILIATION_READINESS_BLOCKED:'VSAM/COBOL prerequisites did not pass. No reconciliation JCL was submitted.',RECONCILIATION_TIMEOUT:'The JES polling window elapsed. The run is unresolved and must not be resubmitted.',RECONCILIATION_OUTPUT_INVALID:'The completed VSAM/COBOL job did not provide valid output and count evidence.',RECONCILIATION_STEP_FAILED:'A VSAM creation, load, or COBOL step failed its required return-code gate.',RECONCILIATION_SUBMISSION_UNCERTAIN:'Reconciliation job submission outcome is unknown; inspect JES and do not resubmit.'};return {code,message:messages[code]??safeSmokeErrorMessage(error)}; }
function expectedPlanConfig(env:NodeJS.ProcessEnv):MainframePlanConfig {
  const hlq=(env.MAINFRAME_HLQ??'').trim().toUpperCase();const sourceLibrary=(env.MAINFRAME_SOURCE_LIBRARY??'').trim().toUpperCase();const loadLibrary=(env.MAINFRAME_LOAD_LIBRARY??'').trim().toUpperCase();const jobClass=(env.MAINFRAME_JOB_CLASS??'').trim().toUpperCase();
  const loadModule=(env.MAINFRAME_LOAD_MODULE??'RECONCIL').trim().toUpperCase();const rexxMember=(env.MAINFRAME_REXX_MEMBER??'VALIDATE').trim().toUpperCase();
  if(hlq!=='Z73968'||!sourceLibrary.startsWith(`${hlq}.`)||!loadLibrary.startsWith(`${hlq}.`)||!/^Z73968(?:\.[A-Z#$@][A-Z0-9#$@]{0,7}){1,4}$/.test(sourceLibrary)||!/^Z73968(?:\.[A-Z#$@][A-Z0-9#$@]{0,7}){1,4}$/.test(loadLibrary)||! /^[A-Z0-9]$/.test(jobClass)) fail('Run-specific preflight requires valid server configuration under the assigned Z73968 HLQ.','MAINFRAME_CONFIGURATION_INVALID');
  return {hlq,sourceLibrary,loadLibrary,jobClass,loadModule,rexxMember};
}
function verifyInput(input:PreflightInput, stagingRoot:string):void {
  if(!input.valid||! /^[0-9a-f-]{36}$/i.test(input.uploadId)||! /^[a-f0-9]{64}$/i.test(input.sha256)||path.basename(input.stagedPath)!==`${input.uploadId}.txt`) fail('Stored upload metadata is invalid.','STAGED_INPUT_INVALID');
  const root=path.resolve(stagingRoot);const file=path.resolve(input.stagedPath);const relative=path.relative(root,file);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||path.dirname(file)!==root) fail('Stored upload reference is outside the approved staging directory.','STAGED_INPUT_INVALID');
}
async function readInput(input:PreflightInput,stagingRoot:string):Promise<{bytes:Buffer;records:string[]}> {
  verifyInput(input,stagingRoot);const stat=await fs.lstat(input.stagedPath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==input.size||stat.size>10*1024*1024) fail('Staged input is missing or its size changed.','STAGED_INPUT_CHANGED');
  const bytes=await fs.readFile(input.stagedPath);if(crypto.createHash('sha256').update(bytes).digest('hex')!==input.sha256)fail('Staged input hash no longer matches the saved upload.','STAGED_INPUT_CHANGED');
  let parsed:{records:string[];recordCount:number};try{parsed=validateDatasetUpload(bytes);}catch{fail('Staged input no longer satisfies the 38-byte fixed-width contract.','STAGED_INPUT_INVALID');}
  if(parsed.recordCount!==input.recordCount)fail('Staged input record count no longer matches upload metadata.','STAGED_INPUT_CHANGED');
  return {bytes,records:parsed.records};
}
function readOutput(bytes:Buffer,allowEmpty=false):string[] {
  if(bytes.length===0&&allowEmpty)return [];
  try { return validateDatasetUpload(bytes).records; } catch { fail('A remote preflight output contains invalid fixed-width records.','OUTPUT_INVALID'); }
}
function assertSorted(records:string[],unique:boolean):void {
  if(records.some((row,index)=>index>0&&records[index-1]!.slice(0,10)>row.slice(0,10)))fail('Remote preflight output is not sorted by bytes 1–10 ascending.','OUTPUT_INVALID');
  if(unique&&records.some((row,index)=>index>0&&records[index-1]!.slice(0,10)===row.slice(0,10)))fail('Transaction sort output does not follow the expected duplicate-elimination policy.','OUTPUT_INVALID');
}
export function parsePreflightStepCodes(spool:string):Record<string,number> {
  const codes:Record<string,number>={};
  for(const line of spool.split(/\r?\n/)){
    const match=/\bIEF142I\s+\S+\s+(TXNSORT|SETSORT|DUPSEL|DUPCNT)\s+-.*?COND CODE\s+(\d{1,4})\b/i.exec(line);
    if(match){const step=match[1]!.toUpperCase();if(codes[step]!==undefined)fail('JES spool contains ambiguous duplicate step evidence.','JES_STEP_EVIDENCE_INVALID');codes[step]=Number(match[2]);}
  }
  return codes;
}
export function assertPreflightStepCodes(returnCode:number,codes:Record<string,number>):'CLEAN'|'DUPLICATES' {
  const required=['TXNSORT','SETSORT','DUPSEL'];
  for(const step of required) if(codes[step]!==0) fail(`JES spool does not confirm successful ${step} execution.`,'JES_STEP_EVIDENCE_MISSING');
  if(codes.DUPCNT===0&&returnCode===0)return 'CLEAN';
  if(codes.DUPCNT===8&&returnCode===8)return 'DUPLICATES';
  if(codes.DUPCNT===undefined&&returnCode!==0&&returnCode!==8) fail('A predecessor preflight step failed; later steps were correctly gated.','JES_NONZERO_RETURN_CODE');
  fail('Overall JES return code and duplicate-count step evidence do not agree.','JES_STEP_EVIDENCE_INVALID');
}
function checkAttributes(dataset:string,a:DatasetAttributes):void { if(a.dsname.toUpperCase()!==dataset.toUpperCase()||a.dsorg?.toUpperCase()!=='PS'||a.recfm?.toUpperCase()!=='FB'||Number(a.lrecl)!==38)fail('Remote dataset attributes did not verify as the exact PS/FB/LRECL=38 resource.','DATASET_ATTRIBUTES_MISMATCH'); }
async function save(deps:PreflightDependencies,op:BankingPreflight):Promise<void>{op.updatedAt=(deps.now??(()=>new Date()))();await deps.persist(op);}

export function prepareBankingPreflight(input:{actorId:string;idempotencyKey:string;organizationId:string;organizationName:string;profile:'SMOKE'|'VOLUME_10K'|'NEGATIVE';transaction:PreflightInput;settlement:PreflightInput},env:NodeJS.ProcessEnv,now= new Date()):BankingPreflight {
  if(!/^[\w.@-]{1,120}$/.test(input.actorId)||! /^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey))fail('Authenticated actor and unique idempotency key are required.','PREFLIGHT_REQUEST_INVALID');
  const runId=createRunId(now);const plan=buildRunExecutionPlan(runId,expectedPlanConfig(env),createDatasetToken(),{transaction:{originalName:input.transaction.originalName,size:input.transaction.size,recordCount:input.transaction.recordCount,valid:input.transaction.valid},settlement:{originalName:input.settlement.originalName,size:input.settlement.size,recordCount:input.settlement.recordCount,valid:input.settlement.valid}});
  const jcl=generatePreflightJcl(plan);assertRunScopedJclContract(plan,'preflight',jcl);
  const datasets=DATASET_ROLES.map((role)=>({name:plan.datasets[role],role,state:'PLANNED' as const}));
  if(datasets.some(d=>!d.name.startsWith('Z73968.')||/ZXP\.PUBLIC|Z73968\.BANK/i.test(d.name)))fail('Generated preflight dataset is outside the assigned run namespace.','DATASET_SCOPE_INVALID');
  return {operationId:crypto.randomUUID(),runId,actorId:input.actorId,idempotencyKey:input.idempotencyKey,activeLock:input.actorId,organizationId:input.organizationId,organizationName:input.organizationName,state:'PREPARED',stage:'PREPARED',profile:input.profile,inputs:{transaction:input.transaction,settlement:input.settlement},runQualifier:plan.token,plan,jcl,datasets,stageResults:{resourceRetention:'Run-owned input, sorted, and duplicate-evidence datasets are retained for review and any later approved stage. This preflight does not clean remote datasets.'},createdAt:now};
}

export async function executeBankingPreflight(op:BankingPreflight,deps:PreflightDependencies):Promise<BankingPreflight> {
  if(TERMINAL.has(op.state))return op;
  let localJcl:string|undefined;const transferCopies:string[]=[];const downloads:string[]=[];let submissionInvoked=false;let completedJobFailure=false;let uploadingItem:PreflightDataset|undefined;
  try {
    op.state='PREFLIGHT';op.stage='CONFIGURATION_AND_READINESS';await save(deps,op);
    if(deps.env.MAINFRAME_JOB_SUBMISSION_ENABLED!=='true')fail('Approved preflight submission is disabled by MAINFRAME_JOB_SUBMISSION_ENABLED.','JOB_SUBMISSION_DISABLED');
    if(deps.env.MAINFRAME_DATASET_MUTATIONS_ENABLED!=='true'||(deps.env.MAINFRAME_DATASET_MUTATION_SCOPE??'').trim().toUpperCase()!=='Z73968')fail('Run-scoped input dataset mutations are disabled or outside the configured Z73968 project scope.','DATASET_MUTATIONS_DISABLED');
    if(deps.env.MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED!=='true')fail('The administrator has not accepted the configured local Zowe profile TLS risk for this mainframe preflight. This flag does not verify certificates or enable reconciliation.','TLS_RISK_NOT_ACCEPTED');
    const readiness=await deps.readiness();if(readiness.state!=='DATASET_ACCESS_VERIFIED')fail(readiness.message||'The read-only Zowe connection and dataset check failed.','ZOWE_NOT_READY');
    const input={transaction:await readInput(op.inputs.transaction,deps.stagingRoot),settlement:await readInput(op.inputs.settlement,deps.stagingRoot)};
    op.stageResults.inputValidation={transaction:{sha256:op.inputs.transaction.sha256,size:input.transaction.bytes.length,recordCount:input.transaction.records.length},settlement:{sha256:op.inputs.settlement.sha256,size:input.settlement.bytes.length,recordCount:input.settlement.records.length}};await save(deps,op);
    op.stage='DATASET_COLLISION_CHECK';await save(deps,op);
    for(const item of op.datasets){try{const existing=await deps.remote.attributes(item.name);if(existing.dsname.toUpperCase()===item.name.toUpperCase())fail(`Run-specific dataset ${item.name} already exists; no existing resource will be overwritten.`,'DATASET_COLLISION');fail('Dataset query returned an unexpected resource.','DATASET_RESPONSE_INVALID');}catch(error){if(errorCode(error)!=='DATASET_NOT_FOUND')throw error;}}
    for(const item of op.datasets)await deps.ownership(op,item,'PLANNED');
    for(const item of op.datasets.slice(0,2)){
      op.state='ALLOCATING';op.stage=`ALLOCATE_${item.role}`;item.state='CREATING';await deps.ownership(op,item,'CREATING');await save(deps,op);
      const tracks=item.role==='TXNIN'?op.plan.allocation.transactionInputTracks:op.plan.allocation.settlementInputTracks;const secondary=Math.max(1,Math.ceil(tracks*0.25));
      try{const allocation=await deps.remote.create(item.name,tracks,secondary);item.state='CREATED';const attributes=await deps.remote.attributes(item.name);checkAttributes(item.name,attributes);item.attributes=attributes;await deps.ownership(op,item,'CREATED');op.stageResults[`allocation_${item.role}`]={requested:{primaryTracks:tracks,secondaryTracks:secondary,unit:'TRK'},result:allocation,attributes};await save(deps,op);}catch(error){item.state='UNCERTAIN';item.errorCategory=errorCode(error);await deps.ownership(op,item,'UNCERTAIN',item.errorCategory);throw error;}
    }
    for(const [role,records] of [['TXNIN',input.transaction.records],['SETIN',input.settlement.records]] as const){
      const item=op.datasets.find(d=>d.role===role)!;op.state='UPLOADING';op.stage=`UPLOAD_${role}`;await save(deps,op);
      const copy=await writeTransferCopy(records,deps.stagingRoot);transferCopies.push(copy);uploadingItem=item;item.state='UPLOADING';await deps.ownership(op,item,'UPLOADING');await save(deps,op);await deps.remote.upload(item.name,copy);
      const downloaded=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.out`);downloads.push(downloaded);await deps.remote.download(item.name,downloaded);
      const transferredAttributes=await deps.remote.attributes(item.name);checkAttributes(item.name,transferredAttributes);item.attributes=transferredAttributes;
      const readback=normalizeFixedWidthRecords(await fs.readFile(downloaded));if(!sameRecords(records,readback))fail(`Uploaded ${role} content did not match original staged records.`,'READBACK_CONTENT_MISMATCH');
      item.state='ACTIVE';item.recordCount=readback.length;await deps.ownership(op,item,'ACTIVE');op.stageResults[`transfer_${role}`]={encoding:'IBM-1047 text transfer',validatedRecordCount:records.length,readBackRecordCount:readback.length,contentMatch:true,attributesVerifiedAfterTransfer:true,attributes:transferredAttributes};await save(deps,op);uploadingItem=undefined;
    }
    const outputs=op.datasets.slice(2);for(const item of outputs){item.state='CREATING';await deps.ownership(op,item,'CREATING');}op.state='SORTING';op.stage='PREFLIGHT_JCL_SUBMISSION';await save(deps,op);
    await fs.mkdir(path.resolve(deps.stagingRoot),{recursive:true});localJcl=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.jcl`);await fs.writeFile(localJcl,op.jcl,{flag:'wx',mode:0o600});
    submissionInvoked=true;const submitted=await deps.remote.submitJcl(localJcl);if(!JOB_ID.test(submitted.jobId))fail('Preflight submission returned no validated JES job ID.','JES_JOB_ID_MISSING');
    op.jobId=submitted.jobId.toUpperCase();op.submittedAt=(deps.now??(()=>new Date()))();op.state='SORTING';op.stage='JES_POLLING';await save(deps,op);
    const attempts=deps.pollAttempts??12;if(!Number.isInteger(attempts)||attempts<1||attempts>30)fail('Preflight JES polling bounds are invalid.','POLL_CONFIGURATION_INVALID');
    let status:RemoteJobStatus|undefined;
    for(let i=0;i<attempts;i++){op.lastCheckedAt=(deps.now??(()=>new Date()))();status=await deps.remote.jobStatus(op.jobId);if(status.jobId.toUpperCase()!==op.jobId)fail('JES returned status for a different job.','JES_JOB_MISMATCH');op.jobStatus=status.status;op.returnCode=status.returnCode;op.conditionCode=status.conditionCode;await save(deps,op);if(status.status==='OUTPUT')break;if(i+1<attempts)await (deps.sleep??((ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))))(deps.pollIntervalMs??1500);}
    if(!status||status.status!=='OUTPUT'){op.state='UNRESOLVED';op.stage='JES_POLLING';op.errorCategory='PREFLIGHT_TIMEOUT';op.errorMessage=safeFailure(Object.assign(new Error(''),{code:'PREFLIGHT_TIMEOUT'})).message;await save(deps,op);return op;}
    // The job is terminal; missing or invalid evidence is a failed preflight, not
    // an unknown submission that could justify another job submission.
    completedJobFailure=true;
    if(status.returnCode===null)fail('JES OUTPUT did not include a return code.','JES_RETURN_CODE_MISSING');
    op.stage='JES_SPOOL_RETRIEVAL';const spool=await deps.remote.jobSpool(op.jobId);if(!spool.trim())fail('JES spool was empty.','JES_SPOOL_MISSING');op.spoolText=spool.split(/\r?\n/).map(line=>sanitizeText(line,4000)).join('\n').slice(0,1_000_000);op.stageResults.jes={jobId:op.jobId,status:status.status,returnCode:status.returnCode,conditionCode:status.conditionCode??null,spoolRetrieved:true};await save(deps,op);
    const stepCodes=parsePreflightStepCodes(op.spoolText);op.stageResults.stepReturnCodes=stepCodes;
    if(status.returnCode!==0&&status.returnCode!==8){completedJobFailure=true;fail(`Preflight job completed with unsupported nonzero return code ${status.returnCode}.`,'JES_NONZERO_RETURN_CODE');}
    const duplicateRc=stepCodes.DUPCNT===8&&status.returnCode===8;
    if(Object.entries(stepCodes).some(([step,rc])=>rc!==0&&!(step==='DUPCNT'&&duplicateRc))){completedJobFailure=true;fail('A sort or duplicate-selection step returned a nonzero code; dependent processing remained gated.','JES_NONZERO_RETURN_CODE');}
    if(status.returnCode===8&&!duplicateRc&&Object.values(stepCodes).every(rc=>rc===0)){completedJobFailure=true;fail('JES overall RC 8 is not supported by a DUPCNT RC 8 result.','JES_STEP_EVIDENCE_INVALID');}
    const resultClass=assertPreflightStepCodes(status.returnCode,stepCodes);
    op.state='VERIFYING_OUTPUTS';op.stage='OUTPUT_DATASET_VERIFICATION';await save(deps,op);
    const outputRows:Record<string,string[]>={};
    for(const item of outputs){
      try{const a=await deps.remote.attributes(item.name);checkAttributes(item.name,a);const downloaded=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.out`);downloads.push(downloaded);await deps.remote.download(item.name,downloaded);const rows=readOutput(await fs.readFile(downloaded),item.role==='DUPES');item.attributes=a;item.recordCount=rows.length;item.state='CREATED';await deps.ownership(op,item,'CREATED');outputRows[item.role]=rows;}
      catch(error){if(errorCode(error)==='DATASET_NOT_FOUND'){item.state='PLANNED';await deps.ownership(op,item,'PLANNED');}else{item.state='UNCERTAIN';item.errorCategory=errorCode(error);await deps.ownership(op,item,'UNCERTAIN',item.errorCategory);}throw error;}
    }
    const txnSorted=outputRows.TXNSORT!;const setSorted=outputRows.SETSORT!;const duplicates=outputRows.DUPES!;assertSorted(txnSorted,true);assertSorted(setSorted,false);
    if(txnSorted.length>op.inputs.transaction.recordCount||setSorted.length!==op.inputs.settlement.recordCount)fail('Sorted output record counts do not agree with the uploaded record evidence.','READBACK_COUNT_MISMATCH');
    const settlementFrequency=new Map<string,number>();for(const row of setSorted)settlementFrequency.set(row.slice(0,10),(settlementFrequency.get(row.slice(0,10))??0)+1);
    const expectedDuplicates=setSorted.filter(row=>(settlementFrequency.get(row.slice(0,10))??0)>1);
    if(!sameRecords(expectedDuplicates,duplicates))fail('The run-specific duplicate output does not match all duplicate-key settlement records.','OUTPUT_INVALID');
    if(resultClass==='DUPLICATES'&&duplicates.length===0)fail('JES reports duplicate-key RC=8 but the run-specific duplicate dataset is empty.','JES_STEP_EVIDENCE_INVALID');
    if(resultClass==='CLEAN'&&duplicates.length!==0)fail('JES reports RC=0 while duplicate-key evidence is present.','JES_STEP_EVIDENCE_INVALID');
    op.stageResults.sortedOutputs={transaction:{dataset:op.plan.datasets.TXNSORT,recordCount:txnSorted.length,duplicatesEliminated:op.inputs.transaction.recordCount-txnSorted.length,sortOrderVerified:true},settlement:{dataset:op.plan.datasets.SETSORT,recordCount:setSorted.length,sortOrderVerified:true},settlementDuplicateEvidence:{dataset:op.plan.datasets.DUPES,recordCount:duplicates.length,duplicateKeys:[...new Set(duplicates.map(row=>row.slice(0,10)))]}};
    op.state=resultClass==='CLEAN'?'READY_FOR_RECONCILIATION':'DUPLICATES_FOUND';op.stage=resultClass==='CLEAN'?'PREFLIGHT_COMPLETE':'DUPLICATE_SETTLEMENT_KEYS';op.completedAt=(deps.now??(()=>new Date()))();
  } catch(error){
    const failure=safeFailure(error);op.errorCategory=failure.code;op.errorMessage=failure.message;op.stageResults.failure={stage:op.stage,category:failure.code,message:failure.message};
    op.state=submissionInvoked?(op.jobId?(completedJobFailure?'FAILED':'UNRESOLVED'):'SUBMISSION_UNCERTAIN'):'FAILED';if(TERMINAL.has(op.state))op.completedAt=(deps.now??(()=>new Date()))();
    if(uploadingItem){uploadingItem.state='UNCERTAIN';uploadingItem.errorCategory=failure.code;await deps.ownership(op,uploadingItem,'UNCERTAIN',failure.code).catch(()=>undefined);}
    for(const item of op.datasets.filter(d=>d.state==='CREATING')){item.state='UNCERTAIN';item.errorCategory=failure.code;await deps.ownership(op,item,'UNCERTAIN',failure.code).catch(()=>undefined);}
  } finally {
    for(const file of [...transferCopies,...downloads,...(localJcl?[localJcl]:[])])await fs.unlink(file).catch(()=>undefined);
    await save(deps,op);
  }
  return op;
}

const RECONCILIATION_DATASET_ROLES = ['SETTLE','SETTLE_DATA','SETTLE_INDEX','MATCHOUT','MISMOUT','TXNMISS','SETMISS'] as const;
const RECONCILIATION_STEP_NAMES = ['VSAMCRT','VSAMLOAD','RECONCIL'] as const;
const OUTPUT_LAYOUTS = { MATCHOUT:38, MISMOUT:120, TXNMISS:120, SETMISS:120 } as const;
const TERMINAL_JES = new Set(['ABEND','CANCELED','CANCELLED','JCL ERROR']);

const RETRYABLE_LOAD_MODULE_ERRORS=new Set(['LOAD_MODULE_UNVERIFIED','DATASET_RESPONSE_INVALID','RFJ_RESOURCE_INVALID','AUTHENTICATION','AUTHORIZATION','NETWORK','TLS','TIMEOUT','ZOWE_TIMEOUT','CLI_UNAVAILABLE']);
export function canResumeLoadModuleVerification(op:Pick<BankingPreflight,'state'|'stage'|'errorCategory'|'datasets'|'stageResults'>):boolean {
  if(!['RECONCILIATION_BLOCKED','RECONCILIATION_PREFLIGHT'].includes(op.state)||!['LOAD_MODULE_VERIFICATION','LOAD_MODULE_RETRY_REQUESTED'].includes(op.stage)||!op.errorCategory||!RETRYABLE_LOAD_MODULE_ERRORS.has(op.errorCategory))return false;
  const evidence=objectValue(op.stageResults.reconciliation);const failure=objectValue(evidence?.failure);const job=objectValue(evidence?.job);
  if(failure?.stage!=='LOAD_MODULE_VERIFICATION'||failure.category!==op.errorCategory||job?.jobId!==undefined||evidence?.submittedAt!==undefined)return false;
  const targets=op.datasets.filter((item)=>RECONCILIATION_DATASET_ROLES.includes(item.role as typeof RECONCILIATION_DATASET_ROLES[number]));
  return targets.length===RECONCILIATION_DATASET_ROLES.length&&targets.every((item)=>item.state==='PLANNED');
}
export function reconciliationContinuationDisposition(state:PreflightState,safeLoadModuleResume=false):'CONTINUE'|'REPLAY'|'NOT_READY' {
  if(state==='READY_FOR_RECONCILIATION')return 'CONTINUE';
  if(state==='RECONCILIATION_BLOCKED'&&safeLoadModuleResume)return 'CONTINUE';
  if(['RECONCILIATION_PREFLIGHT','VSAM_COBOL_RUNNING','RECONCILIATION_BLOCKED','RECONCILIATION_FAILED','RECONCILIATION_UNRESOLVED','RECONCILIATION_COMPLETED','RECONCILIATION_COMPLETED_WITH_EXCEPTIONS'].includes(state))return 'REPLAY';
  return 'NOT_READY';
}

function reconciliationDatasets(op:BankingPreflight):PreflightDataset[] {
  return RECONCILIATION_DATASET_ROLES.map((role)=>({name:op.plan.datasets[role],role,state:'PLANNED'}));
}
function objectValue(value:unknown):Record<string,unknown>|undefined { return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined; }
function positiveInteger(value:unknown):number|undefined { return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined; }
function parseReconciliationStepCodes(spool:string):Record<string,number> {
  const result:Record<string,number>={};
  for(const line of spool.split(/\r?\n/)){
    const match=/\bIEF142I\s+\S+\s+(VSAMCRT|VSAMLOAD|RECONCIL)\s+-.*?COND CODE\s+(\d{1,4})\b/i.exec(line);
    if(match){const name=match[1]!.toUpperCase();if(result[name]!==undefined)fail('JES spool contains ambiguous duplicate VSAM/COBOL step evidence.','JES_STEP_EVIDENCE_INVALID');result[name]=Number(match[2]);}
  }
  if(RECONCILIATION_STEP_NAMES.some((name)=>result[name]===undefined))fail('JES spool did not confirm VSAM creation, VSAM load, and COBOL step return codes.','JES_STEP_EVIDENCE_MISSING');
  return result;
}
function assertSavedPreflight(op:BankingPreflight,claimedByThisRequest:boolean,safeLoadModuleResume:boolean):{transactionCount:number;settlementCount:number} {
  const readyState=op.state==='READY_FOR_RECONCILIATION'||(claimedByThisRequest&&op.state==='RECONCILIATION_PREFLIGHT'&&['RECONCILIATION_REQUESTED','LOAD_MODULE_RETRY_REQUESTED'].includes(op.stage))||(safeLoadModuleResume&&op.state==='RECONCILIATION_BLOCKED'&&op.stage==='LOAD_MODULE_VERIFICATION');
  if(!readyState||!op.jobId||op.jobStatus!=='OUTPUT'||op.returnCode!==0||!op.spoolText)fail('The saved preflight must be READY, have a confirmed JES OUTPUT/RC 0 result, and retain its actual spool.','PREFLIGHT_EVIDENCE_INVALID');
  assertSuccessfulJesJob({jobId:op.jobId,status:op.jobStatus,returnCode:op.returnCode},'Input preflight');
  if(assertPreflightStepCodes(op.returnCode,parsePreflightStepCodes(op.spoolText))!=='CLEAN')fail('The saved preflight did not prove a clean duplicate-key check.','PREFLIGHT_EVIDENCE_INVALID');
  const results=objectValue(op.stageResults.sortedOutputs);
  const transaction=objectValue(results?.transaction);const settlement=objectValue(results?.settlement);const duplicate=objectValue(results?.settlementDuplicateEvidence);
  const transactionCount=positiveInteger(transaction?.recordCount);const settlementCount=positiveInteger(settlement?.recordCount);const duplicateCount=positiveInteger(duplicate?.recordCount);
  const manifest=(role:PreflightDatasetRole)=>op.datasets.find((item)=>item.role===role);
  if(transactionCount===undefined||settlementCount!==op.inputs.settlement.recordCount||duplicateCount!==0||transactionCount>op.inputs.transaction.recordCount||transaction?.sortOrderVerified!==true||settlement?.sortOrderVerified!==true||transaction?.dataset!==op.plan.datasets.TXNSORT||settlement?.dataset!==op.plan.datasets.SETSORT||duplicate?.dataset!==op.plan.datasets.DUPES||['TXNSORT','SETSORT','DUPES'].some((role)=>manifest(role as PreflightDatasetRole)?.state!=='CREATED'))fail('Persisted preflight record counts, datasets, sort checks, or duplicate-free evidence are incomplete.','PREFLIGHT_EVIDENCE_INVALID');
  return {transactionCount,settlementCount};
}
function verifyVsAmAttributes(dataset:string,value:DatasetAttributes):void {
  if(value.dsname.toUpperCase()!==dataset.toUpperCase()||value.dsorg?.toUpperCase()!=='VS'||Number(value.lrecl)!==38)fail('The run-specific settlement KSDS did not verify by exact name as a VSAM resource with 38-byte records.','DATASET_ATTRIBUTES_MISMATCH');
}
function ensureReconciliationGates(env:NodeJS.ProcessEnv,plan:RunExecutionPlan):void {
  const httpsEndpoint=(()=>{try{return new URL(env.MAINFRAME_ENDPOINT??'').protocol==='https:';}catch{return false;}})();
  if(env.MAINFRAME_ENABLED!=='true'||env.MAINFRAME_AUTH_READY!=='true'||env.MAINFRAME_RECONCILIATION_ENABLED!=='true'||env.MAINFRAME_JOB_SUBMISSION_ENABLED!=='true'||env.MAINFRAME_DATASET_MUTATIONS_ENABLED!=='true'||(env.MAINFRAME_DATASET_MUTATION_SCOPE??'').trim().toUpperCase()!=='Z73968'||env.MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED!=='true'||!httpsEndpoint)fail('VSAM/COBOL execution is disabled or its existing server-side execution, authorization, dataset, job, or TLS-risk gates are not satisfied.','RECONCILIATION_DISABLED');
  const config=expectedPlanConfig(env);
  if(config.hlq!==plan.config.hlq||config.jobClass!==plan.config.jobClass||config.sourceLibrary!==plan.config.sourceLibrary||config.loadLibrary!==plan.config.loadLibrary||config.loadModule!==plan.config.loadModule)fail('The saved run plan does not match the current validated server-side execution configuration.','MAINFRAME_CONFIGURATION_INVALID');
}
function assertRunScopedReconciliationJcl(op:BankingPreflight,jcl:string):void {
  assertRunScopedJclContract(op.plan,'reconciliation',jcl);
  if(/ZXP\.PUBLIC\.|Z73968\.BANK\.|\bREPRO[^\n]*\bREPLACE\b/i.test(jcl)||!jcl.includes(`NAME(${op.plan.datasets.SETTLE})`)||!jcl.includes(`KEYS(10 0) RECORDSIZE(38 38)`))fail('Reconciliation JCL did not preserve the exact run-scoped KSDS and deployed COBOL contract.','JCL_CONTRACT_INVALID');
}

/** Continues the exact persisted preflight run. This stage never creates a new run ID
 * or re-uploads/re-submits the sort preflight; all created remote resources are retained. */
export async function executeBankingReconciliationStage(op:BankingPreflight,deps:PreflightDependencies):Promise<BankingPreflight> {
  const safeLoadModuleResume=canResumeLoadModuleVerification(op);
  if(TERMINAL.has(op.state)&&op.state!=='READY_FOR_RECONCILIATION'&&!safeLoadModuleResume)return op;
  const claimedByThisRequest=op.state==='RECONCILIATION_PREFLIGHT'&&['RECONCILIATION_REQUESTED','LOAD_MODULE_RETRY_REQUESTED'].includes(op.stage);
  if(op.state!=='READY_FOR_RECONCILIATION'&&!claimedByThisRequest&&!safeLoadModuleResume)return op;
  let localJcl:string|undefined;const downloads:string[]=[];let submissionInvoked=false;let terminalJobEvidence=false;
  const priorEvidence=objectValue(op.stageResults.reconciliation);const priorFailure=objectValue(priorEvidence?.failure);
  const stageData:Record<string,unknown>={runId:op.runId,state:'VSAM_COBOL_RUNNING',datasets:RECONCILIATION_DATASET_ROLES.map((role)=>({role,dataset:op.plan.datasets[role],state:'PLANNED'})),...(safeLoadModuleResume&&priorFailure?{previousLoadModuleFailure:priorFailure}:{})};
  if(!op.datasets.some((item)=>RECONCILIATION_DATASET_ROLES.includes(item.role as typeof RECONCILIATION_DATASET_ROLES[number])))op.datasets.push(...reconciliationDatasets(op));
  const stageRecord=()=>op.stageResults.reconciliation=stageData;
  try{
    ensureReconciliationGates(deps.env,op.plan);
    // Validate the persisted preflight before replacing its state/stage with the
    // continuation state. The API atomically claims a ready run by changing it
    // to RECONCILIATION_PREFLIGHT / RECONCILIATION_REQUESTED.
    const expected=assertSavedPreflight(op,claimedByThisRequest,safeLoadModuleResume);
    op.state='RECONCILIATION_PREFLIGHT';op.stage='RECONCILIATION_CONFIGURATION';stageRecord();await save(deps,op);
    const readiness=await deps.readiness();if(readiness.state!=='DATASET_ACCESS_VERIFIED')fail(readiness.message||'The read-only Zowe connection and dataset-access check failed.','ZOWE_NOT_READY');

    op.stage='SORTED_INPUT_REVALIDATION';await save(deps,op);
    const verifiedInputs:{TXNSORT:string[];SETSORT:string[];DUPES:string[]}={TXNSORT:[],SETSORT:[],DUPES:[]};
    for(const [role,allowEmpty] of [['TXNSORT',false],['SETSORT',false],['DUPES',true]] as const){
      const item=op.datasets.find((dataset)=>dataset.role===role)!;const attributes=await deps.remote.attributes(item.name);checkAttributes(item.name,attributes);
      const local=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.out`);downloads.push(local);await deps.remote.download(item.name,local);
      const records=readOutput(await fs.readFile(local),allowEmpty);item.attributes=attributes;item.recordCount=records.length;verifiedInputs[role]=records;
    }
    assertSorted(verifiedInputs.TXNSORT,true);assertSorted(verifiedInputs.SETSORT,false);
    if(verifiedInputs.TXNSORT.length!==expected.transactionCount||verifiedInputs.SETSORT.length!==expected.settlementCount||verifiedInputs.DUPES.length!==0)fail('Run-scoped sorted inputs or duplicate output no longer match the saved clean preflight evidence.','PREFLIGHT_EVIDENCE_INVALID');

    op.stage='LOAD_MODULE_VERIFICATION';await save(deps,op);
    if(!deps.remote.verifyLoadModule)fail('The installed Zowe adapter has no approved read-only load-member check.','LOAD_MODULE_UNVERIFIED');
    const moduleResult=await deps.remote.verifyLoadModule(op.plan.config.loadLibrary,op.plan.config.loadModule);
    stageData.loadModule={library:op.plan.config.loadLibrary,member:op.plan.config.loadModule,verified:moduleResult.verified===true,...(moduleResult.evidence?{evidence:sanitizeText(moduleResult.evidence,180)}:{}),...(moduleResult.message?{message:sanitizeText(moduleResult.message,180)}:{})};
    await save(deps,op);
    if(!moduleResult.verified)fail(moduleResult.message??`The configured load member ${op.plan.config.loadModule} was not present in ${op.plan.config.loadLibrary}.`,'LOAD_MODULE_UNVERIFIED');

    const targets=op.datasets.filter((item)=>RECONCILIATION_DATASET_ROLES.includes(item.role as typeof RECONCILIATION_DATASET_ROLES[number]));
    if(targets.length!==RECONCILIATION_DATASET_ROLES.length||new Set(targets.map((item)=>item.name)).size!==targets.length||targets.some((item)=>item.name!==op.plan.datasets[item.role as keyof typeof op.plan.datasets]||!item.name.startsWith(`Z73968.${op.runQualifier}.`)||/ZXP\.PUBLIC|Z73968\.BANK/i.test(item.name)))fail('The persisted VSAM/COBOL manifest does not contain only unique resources owned by this run.','DATASET_SCOPE_INVALID');
    const jcl=generateReconciliationJcl(op.plan);assertRunScopedReconciliationJcl(op,jcl);op.reconciliationJcl=jcl;
    op.stage='DATASET_COLLISION_CHECK_RECONCILIATION';stageRecord();await save(deps,op);
    for(const item of targets){
      try{const found=await deps.remote.attributes(item.name);if(found.dsname.toUpperCase()!==item.name.toUpperCase())fail('An exact-name collision query returned a different resource.','DATASET_RESPONSE_INVALID');fail(`Run output ${item.name} already exists; no existing resource will be overwritten.`,'DATASET_COLLISION');}
      catch(error){if(errorCode(error)!=='DATASET_NOT_FOUND')throw error;}
    }
    for(const item of targets)await deps.ownership(op,item,'PLANNED');
    for(const item of targets){item.state='CREATING';await deps.ownership(op,item,'CREATING');}
    stageData.datasets=targets.map((item)=>({role:item.role,dataset:item.name,state:'CREATING'}));
    op.state='VSAM_COBOL_RUNNING';op.stage='VSAM_COBOL_JCL_SUBMISSION';stageRecord();await save(deps,op);
    await fs.mkdir(path.resolve(deps.stagingRoot),{recursive:true});localJcl=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.jcl`);await fs.writeFile(localJcl,jcl,{flag:'wx',mode:0o600});
    submissionInvoked=true;
    const submitted=await deps.remote.submitJcl(localJcl);if(!JOB_ID.test(submitted.jobId))fail('The VSAM/COBOL submission did not return a validated JES job ID.','JES_JOB_ID_MISSING');
    const jobId=submitted.jobId.toUpperCase();const submittedAt=(deps.now??(()=>new Date()))();stageData.job={jobId,status:'SUBMITTED',submittedAt};op.stage='VSAM_COBOL_JES_POLLING';stageRecord();await save(deps,op);
    const attempts=deps.pollAttempts??20;if(!Number.isInteger(attempts)||attempts<1||attempts>60)fail('The reconciliation JES polling bound is invalid.','POLL_CONFIGURATION_INVALID');
    let status:RemoteJobStatus|undefined;
    for(let i=0;i<attempts;i++){
      op.lastCheckedAt=(deps.now??(()=>new Date()))();status=await deps.remote.jobStatus(jobId);
      if(status.jobId.toUpperCase()!==jobId)fail('JES returned status for a different reconciliation job.','JES_JOB_MISMATCH');
      stageData.job={jobId,status:status.status,returnCode:status.returnCode,conditionCode:status.conditionCode??null,submittedAt,lastCheckedAt:op.lastCheckedAt};stageRecord();await save(deps,op);
      if(status.status==='OUTPUT'||TERMINAL_JES.has(status.status.toUpperCase()))break;
      if(i+1<attempts)await (deps.sleep??((ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))))(deps.pollIntervalMs??1500);
    }
    if(!status||(!['OUTPUT'].includes(status.status)&&!TERMINAL_JES.has(status.status.toUpperCase()))){op.state='RECONCILIATION_UNRESOLVED';op.stage='VSAM_COBOL_JES_POLLING';op.errorCategory='RECONCILIATION_TIMEOUT';op.errorMessage=safeFailure(Object.assign(new Error(''),{code:'RECONCILIATION_TIMEOUT'})).message;stageData.outcome='UNRESOLVED';stageRecord();op.completedAt=(deps.now??(()=>new Date()))();await save(deps,op);return op;}
    terminalJobEvidence=true;
    op.stage='VSAM_COBOL_SPOOL_RETRIEVAL';await save(deps,op);
    let spool='';try{spool=await deps.remote.jobSpool(jobId);}catch(error){if(status.status==='OUTPUT')throw error;spool='';}
    if(spool)stageData.spoolText=spool.split(/\r?\n/).map((line)=>sanitizeText(line,4000)).join('\n').slice(0,1_000_000);
    stageData.job={jobId,status:status.status,returnCode:status.returnCode,conditionCode:status.conditionCode??null,submittedAt,completedAt:(deps.now??(()=>new Date()))()};stageRecord();await save(deps,op);
    if(status.status!=='OUTPUT')fail(`The reconciliation job ended in JES status ${sanitizeText(status.status,40)}.`,'RECONCILIATION_STEP_FAILED');
    if(status.returnCode!==0&&status.returnCode!==4)fail(`The VSAM/COBOL job returned unsupported technical code ${status.returnCode??'unknown'}.`,'RECONCILIATION_STEP_FAILED');
    if(!spool.trim())fail('The completed VSAM/COBOL job did not return spool evidence.','JES_SPOOL_MISSING');
    const stepCodes=parseReconciliationStepCodes(spool);stageData.stepReturnCodes=stepCodes;
    if(stepCodes.VSAMCRT!==0||stepCodes.VSAMLOAD!==0||(stepCodes.RECONCIL!==0&&stepCodes.RECONCIL!==4)||stepCodes.RECONCIL!==status.returnCode)fail('VSAM creation, loading, or COBOL return codes did not meet the required explicit job gates.','RECONCILIATION_STEP_FAILED');

    op.stage='VSAM_AND_OUTPUT_DATASET_VERIFICATION';await save(deps,op);
    const vsam=targets.find((item)=>item.role==='SETTLE')!;const vsamAttributes=await deps.remote.attributes(vsam.name);verifyVsAmAttributes(vsam.name,vsamAttributes);vsam.attributes=vsamAttributes;vsam.state='CREATED';await deps.ownership(op,vsam,'CREATED');
    for(const role of ['SETTLE_DATA','SETTLE_INDEX'] as const){const component=targets.find((item)=>item.role===role)!;component.state='CREATED';component.attributes={componentOf:vsam.name,component:role==='SETTLE_DATA'?'DATA':'INDEX'};await deps.ownership(op,component,'CREATED');}
    const outputCounts:Record<'MATCHOUT'|'MISMOUT'|'TXNMISS'|'SETMISS',number>={MATCHOUT:0,MISMOUT:0,TXNMISS:0,SETMISS:0};const outputEvidence:Record<string,unknown>={};
    for(const [role,recordLength] of Object.entries(OUTPUT_LAYOUTS) as Array<[keyof typeof OUTPUT_LAYOUTS,38|120]>){
      const item=targets.find((dataset)=>dataset.role===role)!;const attributes=await deps.remote.attributes(item.name);if(attributes.dsname.toUpperCase()!==item.name.toUpperCase()||attributes.dsorg?.toUpperCase()!=='PS'||attributes.recfm?.toUpperCase()!=='FB'||Number(attributes.lrecl)!==recordLength)fail(`${role} did not verify as the expected run-specific PS/FB/${recordLength} dataset.`,'DATASET_ATTRIBUTES_MISMATCH');
      const local=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.out`);downloads.push(local);await deps.remote.download(item.name,local);const bytes=await fs.readFile(local);const recordCount=countDownloadedRecords(bytes,recordLength);item.attributes=attributes;item.recordCount=recordCount;item.state='CREATED';await deps.ownership(op,item,'CREATED');outputCounts[role]=recordCount;outputEvidence[role]={dataset:item.name,recordCount,recordLength,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),verified:true};
    }
    const counts:CobolCounts=parseCobolCounts(spool);const consistency=countConsistencyError(counts);
    if(consistency||counts.transactionCount!==expected.transactionCount||counts.settlementCount!==expected.settlementCount||counts.matchedCount!==outputCounts.MATCHOUT||counts.mismatchedCount!==outputCounts.MISMOUT||counts.transactionOnlyCount!==outputCounts.TXNMISS||counts.settlementOnlyCount!==outputCounts.SETMISS)fail(consistency??'Six COBOL summary counts did not agree with sorted inputs and verified physical output counts.','RECONCILIATION_OUTPUT_INVALID');
    const hasExceptions=counts.mismatchedCount+counts.transactionOnlyCount+counts.settlementOnlyCount>0;
    if((status.returnCode===0&&hasExceptions)||(status.returnCode===4&&!hasExceptions))fail('The COBOL return code did not agree with its verified discrepancy counts.','RECONCILIATION_OUTPUT_INVALID');
    stageData.summary=counts;stageData.physicalOutputCounts=outputCounts;stageData.outputs=outputEvidence;stageData.outcome=hasExceptions?'COMPLETED_WITH_EXCEPTIONS':'COMPLETED';stageData.financialTotals='Not available in the deployed COBOL output.';
    op.state=hasExceptions?'RECONCILIATION_COMPLETED_WITH_EXCEPTIONS':'RECONCILIATION_COMPLETED';op.stage='VSAM_COBOL_EVIDENCE_VERIFIED';op.completedAt=(deps.now??(()=>new Date()))();stageRecord();
  }catch(error){
    const uncertainSubmission=submissionInvoked&&op.stage==='VSAM_COBOL_JCL_SUBMISSION'&&!objectValue(stageData.job)?.jobId;
    const failure=uncertainSubmission?safeFailure(Object.assign(new Error(''),{code:'RECONCILIATION_SUBMISSION_UNCERTAIN'})):safeFailure(error);op.errorCategory=failure.code;op.errorMessage=failure.message;
    stageData.failure={stage:op.stage,category:failure.code,message:failure.message};stageRecord();
    op.state=submissionInvoked?(op.stage==='VSAM_COBOL_JCL_SUBMISSION'&&!objectValue(stageData.job)?.jobId?'RECONCILIATION_UNRESOLVED':terminalJobEvidence?'RECONCILIATION_FAILED':'RECONCILIATION_UNRESOLVED'):'RECONCILIATION_BLOCKED';
    if(op.state==='RECONCILIATION_UNRESOLVED')stageData.outcome='UNRESOLVED';
    else if(op.state==='RECONCILIATION_BLOCKED')stageData.outcome='BLOCKED';
    else stageData.outcome='FAILED';
    op.completedAt=(deps.now??(()=>new Date()))();
    for(const item of op.datasets.filter((dataset)=>RECONCILIATION_DATASET_ROLES.includes(dataset.role as typeof RECONCILIATION_DATASET_ROLES[number])&&dataset.state==='CREATING')){item.state='UNCERTAIN';item.errorCategory=failure.code;await deps.ownership(op,item,'UNCERTAIN',failure.code).catch(()=>undefined);}
  }finally{
    for(const file of [...downloads,...(localJcl?[localJcl]:[])])await fs.unlink(file).catch(()=>undefined);
    await save(deps,op);
  }
  return op;
}

export function publicBankingPreflight(op:BankingPreflight,includeSpool=true){
  const stageResults=structuredClone(op.stageResults);
  const intake=stageResults.inputValidation as {transaction?:Record<string,unknown>;settlement?:Record<string,unknown>}|undefined;
  if(intake){if(intake.transaction)delete intake.transaction.sha256;if(intake.settlement)delete intake.settlement.sha256;}
  const reconciliation=objectValue(stageResults.reconciliation);const reconciliationJob=objectValue(reconciliation?.job);
  return {
    operationId:op.operationId,runId:op.runId,organizationId:op.organizationId,organizationName:op.organizationName,state:op.state,stage:op.stage,profile:op.profile,runQualifier:op.runQualifier,createdAt:op.createdAt,
    inputs:{transaction:{uploadId:op.inputs.transaction.uploadId,originalName:op.inputs.transaction.originalName,size:op.inputs.transaction.size,recordCount:op.inputs.transaction.recordCount},settlement:{uploadId:op.inputs.settlement.uploadId,originalName:op.inputs.settlement.originalName,size:op.inputs.settlement.size,recordCount:op.inputs.settlement.recordCount}},
    datasets:op.datasets.map(({name,role,state,recordCount,errorCategory})=>({name,role,state,recordCount,errorCategory})),stageResults,
    jobId:op.jobId,jobStatus:op.jobStatus,returnCode:op.returnCode,conditionCode:op.conditionCode,
    ...(typeof reconciliationJob?.jobId==='string'?{reconciliationJobId:reconciliationJob.jobId}:{}),...(typeof reconciliationJob?.status==='string'?{reconciliationJobStatus:reconciliationJob.status}:{}),...(typeof reconciliationJob?.returnCode==='number'?{reconciliationReturnCode:reconciliationJob.returnCode}:{}),
    submittedAt:op.submittedAt,lastCheckedAt:op.lastCheckedAt,completedAt:op.completedAt,errorCategory:op.errorCategory,errorMessage:op.errorMessage,canResumeReconciliation:canResumeLoadModuleVerification(op),...(includeSpool&&op.spoolText?{spoolText:op.spoolText}:{})
  };
}
