import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPreflightStepCodes, canResumeLoadModuleVerification, executeBankingPreflight, executeBankingReconciliationStage, parsePreflightStepCodes, prepareBankingPreflight, publicBankingPreflight, reconciliationContinuationDisposition, type PreflightDependencies, type PreflightInput, type PreflightRemote } from './bankingPreflight.js';
import { validateDatasetUpload } from './datasetLifecycle.js';
import type { CobolCounts } from './executionPlan.js';
import type { DatasetAttributes } from './uploadVerification.js';

const env:NodeJS.ProcessEnv={MAINFRAME_HLQ:'Z73968',MAINFRAME_JOB_CLASS:'7',MAINFRAME_SOURCE_LIBRARY:'Z73968.SOURCE',MAINFRAME_LOAD_LIBRARY:'Z73968.LOAD',MAINFRAME_JOB_SUBMISSION_ENABLED:'true',MAINFRAME_DATASET_MUTATIONS_ENABLED:'true',MAINFRAME_DATASET_MUTATION_SCOPE:'Z73968',MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED:'true'};
const org={actorId:'operator@example.test',idempotencyKey:'preflight-key-00000001',organizationId:'507f1f77bcf86cd799439011',organizationName:'North Bank',profile:'SMOKE' as const};
const row=(id:string,account='ACCOUNT001',amount='000001250')=>`${id.padEnd(10,'0')}${account}${amount}20261026A`;
function spool(ddup=0){return `IEF142I LS123456 TXNSORT - STEP WAS EXECUTED - COND CODE 0000\nIEF142I LS123456 SETSORT - STEP WAS EXECUTED - COND CODE 0000\nIEF142I LS123456 DUPSEL - STEP WAS EXECUTED - COND CODE 0000\nIEF142I LS123456 DUPCNT - STEP WAS EXECUTED - COND CODE ${String(ddup).padStart(4,'0')}`;}
async function staged(root:string,name:string,records:string[]):Promise<PreflightInput>{const uploadId=crypto.randomUUID();const bytes=Buffer.from(`${records.join('\r\n')}\r\n`,'ascii');const stagedPath=path.join(root,`${uploadId}.txt`);await fs.writeFile(stagedPath,bytes,{flag:'wx'});return {uploadId,originalName:name,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),recordCount:validateDatasetUpload(bytes).recordCount,valid:true,stagedPath};}
async function fixture(options:{settlement?:string[];collision?:boolean;submitFailure?:boolean;pendingJob?:boolean;statusRc?:number;duplicateOutput?:string[];uploadFailure?:boolean;readbackMismatch?:boolean;failedStep?:boolean;reconciliationCollision?:boolean;moduleVerified?:boolean;reconciliationSubmitFailure?:boolean;reconciliationPending?:boolean;reconciliationRc?:number}={}){
  const stagingRoot=await fs.mkdtemp(path.join(os.tmpdir(),'ledgerline-preflight-'));const txn=await staged(stagingRoot,'txn.txt',[row('TXN0000002'),row('TXN0000001'),row('TXN0000001','ACCOUNT002')]);const settlement=await staged(stagingRoot,'settle.txt',options.settlement??[row('SET0000002'),row('SET0000001')]);
  const op=prepareBankingPreflight({...org,transaction:txn,settlement},env);const datasets=new Map<string,{attributes:DatasetAttributes;records:string[]}>();let createCalls=0;let uploadCalls=0;let submitCalls=0;let reconciliationSubmitted=false;const deleteCalls=0;
  const remote:PreflightRemote={
    async attributes(dataset){const value=datasets.get(dataset);if(!value){if((options.collision&&dataset===op.plan.datasets.TXNIN)||(options.reconciliationCollision&&dataset===op.plan.datasets.MATCHOUT))return {dsname:dataset,dsorg:'PS',recfm:'FB',lrecl:38};throw Object.assign(new Error('absent'),{code:'DATASET_NOT_FOUND'});}return value.attributes;},
    async create(dataset){createCalls++;datasets.set(dataset,{attributes:{dsname:dataset,dsorg:'PS',recfm:'FB',lrecl:38},records:[]});return {primaryTracks:1,secondaryTracks:1,unit:'TRK'};},
    async upload(dataset,file){uploadCalls++;if(options.uploadFailure)throw Object.assign(new Error('mock transfer failure'),{code:'REMOTE_HTTP_ERROR'});const records=validateDatasetUpload(await fs.readFile(file)).records;datasets.get(dataset)!.records=records;},
    async download(dataset,file){const records=datasets.get(dataset)?.records;if(!records)throw Object.assign(new Error('absent'),{code:'DATASET_NOT_FOUND'});const changed=[...records];if(options.readbackMismatch&&dataset===op.plan.datasets.TXNIN)changed[0]=`${changed[0]!.slice(0,20)}999999999${changed[0]!.slice(29)}`;await fs.writeFile(file,Buffer.from(changed.length?`${changed.join('\r\n')}\r\n`:'','ascii'));},
    async verifyLoadModule(library,member){return options.moduleVerified===false?{verified:false,message:`${library}(${member}) is absent.`}:{verified:true,evidence:`${library}(${member}) exact member result`};},
    async submitJcl(localPath){submitCalls++;const jcl=await fs.readFile(localPath,'utf8');if(jcl.includes('//VSAMCRT')){reconciliationSubmitted=true;if(options.reconciliationSubmitFailure)throw Object.assign(new Error('uncertain'),{code:'TIMEOUT'});if(op.plan.datasets.SETTLE)datasets.set(op.plan.datasets.SETTLE,{attributes:{dsname:op.plan.datasets.SETTLE,dsorg:'VS',lrecl:38},records:[]});for(const role of ['SETTLE_DATA','SETTLE_INDEX'] as const){const d=op.plan.datasets[role];datasets.set(d,{attributes:{dsname:d,dsorg:'VS'},records:[]});}for(const [role,length,records] of [['MATCHOUT',38,[]],['MISMOUT',120,[]],['TXNMISS',120,['T'.repeat(120),'T'.repeat(120)]],['SETMISS',120,['S'.repeat(120),'S'.repeat(120)]]] as const){const d=op.plan.datasets[role];datasets.set(d,{attributes:{dsname:d,dsorg:'PS',recfm:'FB',lrecl:length},records:[...records]});}return {jobId:'JOB01997'};}if(options.submitFailure)throw Object.assign(new Error('timed out'),{code:'TIMEOUT'});for(const [key,records] of [['TXNSORT',[...new Map([...(datasets.get(op.plan.datasets.TXNIN)?.records??[])].sort().map(x=>[x.slice(0,10),x])).values()]],['SETSORT',[...(datasets.get(op.plan.datasets.SETIN)?.records??[])].sort()],['DUPES',options.duplicateOutput??[]]] as const){const d=op.plan.datasets[key];datasets.set(d,{attributes:{dsname:d,dsorg:'PS',recfm:'FB',lrecl:38},records:[...records]});}return {jobId:'JOB01996'};},
    async jobStatus(jobId){const reconciliation=jobId==='JOB01997';const pending=reconciliation?options.reconciliationPending:options.pendingJob;return {jobId,status:pending?'ACTIVE':'OUTPUT',returnCode:pending?null:reconciliation?options.reconciliationRc??4:options.statusRc??0};},
    async jobSpool(jobId){if(jobId==='JOB01997')return `IEF142I LS123456 VSAMCRT - STEP WAS EXECUTED - COND CODE 0000\nIEF142I LS123456 VSAMLOAD - STEP WAS EXECUTED - COND CODE 0000\nIEF142I LS123456 RECONCIL - STEP WAS EXECUTED - COND CODE ${String(options.reconciliationRc??4).padStart(4,'0')}\nTRANSACTION INPUT COUNT: 0000002\nSETTLEMENT INPUT COUNT:  0000002\nMATCHED COUNT:           0000000\nMISMATCHED COUNT:        0000000\nTRANSACTION-ONLY COUNT:  0000002\nSETTLEMENT-ONLY COUNT:   0000002`;return options.failedStep?'IEF142I LS123456 TXNSORT - STEP WAS EXECUTED - COND CODE 0008':spool(options.statusRc===8?8:0);},
  };
  const deps:PreflightDependencies={env,stagingRoot,remote,persist:async()=>undefined,ownership:async()=>undefined,readiness:async()=>({state:'DATASET_ACCESS_VERIFIED',message:'verified'}),sleep:async()=>undefined,pollAttempts:1};
  return {op,deps,stagingRoot,options,counts:()=>({createCalls,uploadCalls,submitCalls,deleteCalls,reconciliationSubmitted})};
}
const reconciliationEnv:NodeJS.ProcessEnv={...env,MAINFRAME_ENABLED:'true',MAINFRAME_AUTH_READY:'true',MAINFRAME_RECONCILIATION_ENABLED:'true',MAINFRAME_ENDPOINT:'https://zosmf.example.invalid'};
async function readyForReconciliation(f:Awaited<ReturnType<typeof fixture>>){const preflight=await executeBankingPreflight(f.op,f.deps);if(preflight.state==='READY_FOR_RECONCILIATION')f.deps.env=reconciliationEnv;return preflight;}

test('preflight generator is run-scoped and keeps the checked-in sort and duplicate control contract',async()=>{
  const f=await fixture();try{assert.match(f.op.jcl,/SORT FIELDS=\(1,10,CH,A\)/);assert.match(f.op.jcl,/SUM FIELDS=NONE/);assert.match(f.op.jcl,/SELECT FROM\(SETIN\) TO\(DUPES\) ON\(1,10,CH\) ALLDUPS/);assert.match(f.op.jcl,/COUNT FROM\(DUPIN\) NOTEQUAL\(0\) RC8/);assert.match(f.op.jcl,/IF \(TXNSORT\.RC = 0\) THEN[\s\S]*IF \(SETSORT\.RC = 0\) THEN[\s\S]*IF \(DUPSEL\.RC = 0\) THEN/);assert.doesNotMatch(f.op.jcl,/ZXP\.PUBLIC\.|Z73968\.BANK\.|DISP=OLD|\bREPLACE\b/i);for(const dataset of f.op.datasets)assert.match(dataset.name,/^Z73968\.[A-Z][A-Z0-9]{7}\./);}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('run-scoped input transfer, actual JES evidence and sorted output readback reach preflight-ready only',async()=>{
  const f=await fixture();try{const result=await executeBankingPreflight(f.op,f.deps);assert.equal(result.state,'READY_FOR_RECONCILIATION');assert.equal(result.jobId,'JOB01996');assert.equal(result.jobStatus,'OUTPUT');assert.equal(result.returnCode,0);assert.equal((result.stageResults.sortedOutputs as {transaction:{recordCount:number};settlement:{recordCount:number}}).transaction.recordCount,2);assert.equal((result.stageResults.sortedOutputs as {settlement:{recordCount:number}}).settlement.recordCount,2);assert.equal(f.counts().createCalls,2);assert.equal(f.counts().submitCalls,1);assert.equal(f.counts().deleteCalls,0);assert.equal(result.spoolText?.includes('DUPCNT'),true);}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('a dataset collision stops before allocation and job submission',async()=>{
  const f=await fixture({collision:true});try{const result=await executeBankingPreflight(f.op,f.deps);assert.equal(result.state,'FAILED');assert.equal(result.stage,'DATASET_COLLISION_CHECK');assert.equal(result.errorCategory,'DATASET_COLLISION');assert.equal(f.counts().createCalls,0);assert.equal(f.counts().submitCalls,0);}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('the live local-profile TLS risk acknowledgement is required before remote preflight work',async()=>{
  const f=await fixture();f.deps.env={...env,MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED:'false'};try{const result=await executeBankingPreflight(f.op,f.deps);assert.equal(result.state,'FAILED');assert.equal(result.errorCategory,'TLS_RISK_NOT_ACCEPTED');assert.equal(f.counts().createCalls,0);assert.equal(f.counts().submitCalls,0);}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('upload/read-back failure is recorded before JCL submission and never cleans remote resources',async()=>{
  const f=await fixture({readbackMismatch:true});try{const result=await executeBankingPreflight(f.op,f.deps);assert.equal(result.state,'FAILED');assert.equal(result.stage,'UPLOAD_TXNIN');assert.equal(result.errorCategory,'READBACK_CONTENT_MISMATCH');assert.equal(f.counts().submitCalls,0);assert.equal(f.counts().deleteCalls,0);}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('duplicate settlement keys require RC 8 plus real step and duplicate-output evidence',async()=>{
  const repeated=row('SET0000001');const f=await fixture({settlement:[repeated,row('SET0000002'),repeated],statusRc:8,duplicateOutput:[repeated,repeated]});try{const result=await executeBankingPreflight(f.op,f.deps);assert.equal(result.state,'DUPLICATES_FOUND');assert.equal(result.returnCode,8);assert.equal(f.counts().submitCalls,1);assert.equal(result.datasets.some(item=>item.role==='DUPES'&&item.recordCount===2),true);assert.doesNotMatch(result.jcl,/VSAMLOAD|RECONCIL|EOD/i);}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('nonzero sort step is a completed failure and does not become a duplicate outcome',async()=>{
  const f=await fixture({statusRc:8,failedStep:true});try{const result=await executeBankingPreflight(f.op,f.deps);assert.equal(result.state,'FAILED');assert.equal(result.jobId,'JOB01996');assert.equal(result.errorCategory,'JES_NONZERO_RETURN_CODE');assert.equal(result.stageResults.stepReturnCodes&&typeof result.stageResults.stepReturnCodes,'object');}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('an uncertain JCL submission is persisted as uncertain and is never retried by the service',async()=>{
  const f=await fixture({submitFailure:true});try{const result=await executeBankingPreflight(f.op,f.deps);assert.equal(result.state,'SUBMISSION_UNCERTAIN');assert.equal(result.jobId,undefined);assert.equal(f.counts().submitCalls,1);assert.equal(result.stageResults.failure&&typeof result.stageResults.failure,'object');const second=await executeBankingPreflight(result,f.deps);assert.equal(second.state,'SUBMISSION_UNCERTAIN');assert.equal(f.counts().submitCalls,1);}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('a job still active after bounded polling remains unresolved and is never resubmitted',async()=>{
  const f=await fixture({pendingJob:true});try{const result=await executeBankingPreflight(f.op,f.deps);assert.equal(result.state,'UNRESOLVED');assert.equal(result.jobId,'JOB01996');assert.equal(result.jobStatus,'ACTIVE');assert.equal(result.errorCategory,'PREFLIGHT_TIMEOUT');assert.equal(f.counts().submitCalls,1);const second=await executeBankingPreflight(result,f.deps);assert.equal(second.state,'UNRESOLVED');assert.equal(f.counts().submitCalls,1);}finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('step code contract rejects missing or mismatched JES evidence',()=>{
  const parsed=parsePreflightStepCodes(spool());assert.equal(assertPreflightStepCodes(0,parsed),'CLEAN');assert.throws(()=>assertPreflightStepCodes(0,{TXNSORT:0,SETSORT:0,DUPSEL:0}),/step evidence/);assert.throws(()=>assertPreflightStepCodes(8,{TXNSORT:0,SETSORT:0,DUPSEL:0,DUPCNT:0}),/do not agree/);assert.equal(assertPreflightStepCodes(8,parsePreflightStepCodes(spool(8))),'DUPLICATES');
});

test('continuation API disposition allows one ready run, replays in-flight or terminal runs, and rejects other states',()=>{
  assert.equal(reconciliationContinuationDisposition('READY_FOR_RECONCILIATION'),'CONTINUE');
  assert.equal(reconciliationContinuationDisposition('RECONCILIATION_PREFLIGHT'),'REPLAY');
  assert.equal(reconciliationContinuationDisposition('RECONCILIATION_UNRESOLVED'),'REPLAY');
  assert.equal(reconciliationContinuationDisposition('RECONCILIATION_COMPLETED_WITH_EXCEPTIONS'),'REPLAY');
  assert.equal(reconciliationContinuationDisposition('DUPLICATES_FOUND'),'NOT_READY');
  assert.equal(reconciliationContinuationDisposition('FAILED'),'NOT_READY');
  assert.equal(reconciliationContinuationDisposition('RECONCILIATION_BLOCKED',true),'CONTINUE');
  assert.equal(reconciliationContinuationDisposition('RECONCILIATION_BLOCKED',false),'REPLAY');
});

test('VSAM and COBOL stage continues the same preflight run and persists real-shaped JES/count/output evidence',async()=>{
  const f=await fixture();try{
    const preflight=await readyForReconciliation(f);assert.equal(preflight.state,'READY_FOR_RECONCILIATION');
    const result=await executeBankingReconciliationStage(preflight,f.deps);
    assert.equal(result.operationId,preflight.operationId);assert.equal(result.runId,preflight.runId);assert.equal(result.jobId,'JOB01996');
    assert.equal(result.state,'RECONCILIATION_COMPLETED_WITH_EXCEPTIONS');assert.equal(f.counts().submitCalls,2);assert.equal(f.counts().reconciliationSubmitted,true);
    const evidence=result.stageResults.reconciliation as {job:{jobId:string;status:string;returnCode:number};summary:CobolCounts;stepReturnCodes:Record<string,number>;outputs:Record<string,{verified:boolean}>;outcome:string};
    assert.equal(evidence.job.jobId,'JOB01997');assert.equal(evidence.job.status,'OUTPUT');assert.equal(evidence.job.returnCode,4);assert.deepEqual(evidence.stepReturnCodes,{VSAMCRT:0,VSAMLOAD:0,RECONCIL:4});
    assert.deepEqual(evidence.summary,{transactionCount:2,settlementCount:2,matchedCount:0,mismatchedCount:0,transactionOnlyCount:2,settlementOnlyCount:2});
    assert.equal(evidence.outputs.TXNMISS?.verified,true);assert.equal(evidence.outputs.SETMISS?.verified,true);assert.equal(evidence.outcome,'COMPLETED_WITH_EXCEPTIONS');
    assert.match(result.reconciliationJcl??'',/IF \(VSAMCRT\.RC = 0\) THEN[\s\S]*IF \(VSAMLOAD\.RC = 0\) THEN[\s\S]*RECONCIL EXEC PGM=RECONCIL/);assert.doesNotMatch(result.reconciliationJcl??'',/ZXP\.PUBLIC\.|Z73968\.BANK\.|\bREPRO[^\n]*REPLACE/i);
    assert.equal(f.counts().deleteCalls,0);
    await executeBankingReconciliationStage(result,f.deps);assert.equal(f.counts().submitCalls,2);
  }finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('duplicate preflight evidence blocks VSAM and COBOL without another JES submission',async()=>{
  const repeated=row('SET0000001');const f=await fixture({settlement:[repeated,row('SET0000002'),repeated],statusRc:8,duplicateOutput:[repeated,repeated]});try{
    const preflight=await executeBankingPreflight(f.op,f.deps);assert.equal(preflight.state,'DUPLICATES_FOUND');
    const result=await executeBankingReconciliationStage(preflight,f.deps);assert.equal(result.state,'DUPLICATES_FOUND');assert.equal(f.counts().submitCalls,1);assert.equal(f.counts().reconciliationSubmitted,false);
  }finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('unverified load module blocks before output collision checks or VSAM/COBOL submission',async()=>{
  const f=await fixture({moduleVerified:false});try{
    const preflight=await readyForReconciliation(f);const result=await executeBankingReconciliationStage(preflight,f.deps);
    assert.equal(result.state,'RECONCILIATION_BLOCKED');assert.equal(result.errorCategory,'LOAD_MODULE_UNVERIFIED');assert.equal(f.counts().submitCalls,1);assert.equal(f.counts().reconciliationSubmitted,false);
    assert.equal((result.stageResults.reconciliation as {loadModule:{verified:boolean}}).loadModule.verified,false);
  }finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('a load-module-only pre-submission block resumes the same run without repeating input transfers',async()=>{
  const f=await fixture({moduleVerified:false});try{
    const preflight=await readyForReconciliation(f);const blocked=await executeBankingReconciliationStage(preflight,f.deps);
    assert.equal(blocked.state,'RECONCILIATION_BLOCKED');assert.equal(blocked.stage,'LOAD_MODULE_VERIFICATION');assert.equal(canResumeLoadModuleVerification(blocked),true);assert.equal(publicBankingPreflight(blocked).canResumeReconciliation,true);
    const allocated=structuredClone(blocked);allocated.datasets.find(item=>item.role==='MATCHOUT')!.state='CREATED';assert.equal(canResumeLoadModuleVerification(allocated),false);
    const submitted=structuredClone(blocked);(submitted.stageResults.reconciliation as {job:{jobId:string}}).job={jobId:'JOB12345'};assert.equal(canResumeLoadModuleVerification(submitted),false);
    f.options.moduleVerified=true;
    const resumed=await executeBankingReconciliationStage(blocked,f.deps);
    assert.equal(resumed.operationId,preflight.operationId);assert.equal(resumed.runId,preflight.runId);assert.equal(resumed.state,'RECONCILIATION_COMPLETED_WITH_EXCEPTIONS');
    assert.equal(f.counts().createCalls,2);assert.equal(f.counts().uploadCalls,2);assert.equal(f.counts().submitCalls,2);
    assert.equal(resumed.datasets.filter(item=>['SETTLE','SETTLE_DATA','SETTLE_INDEX','MATCHOUT','MISMOUT','TXNMISS','SETMISS'].includes(item.role)).length,7);
  }finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('exact output collision blocks the JCL that would allocate run-scoped targets',async()=>{
  const f=await fixture({reconciliationCollision:true});try{
    const preflight=await readyForReconciliation(f);const result=await executeBankingReconciliationStage(preflight,f.deps);
    assert.equal(result.state,'RECONCILIATION_BLOCKED');assert.equal(result.errorCategory,'DATASET_COLLISION');assert.equal(result.stage,'DATASET_COLLISION_CHECK_RECONCILIATION');assert.equal(f.counts().submitCalls,1);assert.equal(f.counts().reconciliationSubmitted,false);
  }finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});

test('uncertain VSAM/COBOL submission is persisted unresolved and never retried',async()=>{
  const f=await fixture({reconciliationSubmitFailure:true});try{
    const preflight=await readyForReconciliation(f);const result=await executeBankingReconciliationStage(preflight,f.deps);
    assert.equal(result.state,'RECONCILIATION_UNRESOLVED');assert.equal(result.errorCategory,'RECONCILIATION_SUBMISSION_UNCERTAIN');assert.equal(f.counts().submitCalls,2);
    await executeBankingReconciliationStage(result,f.deps);assert.equal(f.counts().submitCalls,2);
  }finally{await fs.rm(f.stagingRoot,{recursive:true,force:true});}
});
