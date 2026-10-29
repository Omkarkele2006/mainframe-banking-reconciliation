import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateReconciliationJcl,buildRunExecutionPlan} from './executionPlan.js';
import type {BankingPreflight,PreflightDependencies} from './bankingPreflight.js';
import {recoverEodVerification,canVerifyExistingEod,eodCounts,eodReportLines,generateSettlementJcl,executeEodSettlement} from './eodSettlement.js';

function run():BankingPreflight {
 const plan=buildRunExecutionPlan('REC-20261028-131685A7B479021568CA',{hlq:'Z73968',jobClass:'7',sourceLibrary:'Z73968.SOURCE',loadLibrary:'Z73968.LOAD',loadModule:'RECONCIL',rexxMember:'VALIDATE'},'EV9R0A2L',{transaction:{originalName:'txn.txt',size:200,recordCount:5,valid:true},settlement:{originalName:'set.txt',size:200,recordCount:5,valid:true}});
 const summary={transactionCount:5,settlementCount:5,matchedCount:5,mismatchedCount:0,transactionOnlyCount:0,settlementOnlyCount:0};
 const outputs=Object.fromEntries([['MATCHOUT',5],['MISMOUT',0],['TXNMISS',0],['SETMISS',0]].map(([role,count])=>[role,{dataset:plan.datasets[role as keyof typeof plan.datasets],verified:true,recordCount:count}]));
 const spool=['VSAMCRT','VSAMLOAD','RECONCIL'].map(step=>`IEF142I JOBNAME ${step} - STEP WAS EXECUTED - COND CODE 0000`).join('\n')+'\nTRANSACTION INPUT COUNT: 5\nSETTLEMENT INPUT COUNT: 5\nMATCHED COUNT: 5\nMISMATCHED COUNT: 0\nTRANSACTION-ONLY COUNT: 0\nSETTLEMENT-ONLY COUNT: 0';
 const input={uploadId:'saved-upload',originalName:'input.txt',size:200,sha256:'0'.repeat(64),recordCount:5,valid:true,stagedPath:'unused'};
 return {actorId:'operator',idempotencyKey:'eod-test-key',organizationId:'org',organizationName:'Test Bank',stage:'VSAM_COBOL_EVIDENCE_VERIFIED',profile:'SMOKE',inputs:{transaction:input,settlement:input},createdAt:new Date(),jcl:'saved preflight',operationId:'saved-operation',runId:plan.runId,runQualifier:plan.token,state:'RECONCILIATION_COMPLETED',plan,datasets:(['TXNSORT','SETSORT','MATCHOUT','MISMOUT','TXNMISS','SETMISS'] as const).map(role=>({role,name:plan.datasets[role as keyof typeof plan.datasets],state:'CREATED',recordCount:['TXNSORT','SETSORT','MATCHOUT'].includes(role)?5:0})),stageResults:{reconciliation:{outcome:'COMPLETED',job:{jobId:'JOB00712',status:'OUTPUT',returnCode:0},summary,outputs,spoolText:spool}}} as BankingPreflight;
}
const env={MAINFRAME_ENABLED:'true',MAINFRAME_AUTH_READY:'true',MAINFRAME_RECONCILIATION_ENABLED:'true',MAINFRAME_JOB_SUBMISSION_ENABLED:'true',MAINFRAME_DATASET_MUTATIONS_ENABLED:'true',MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED:'true',MAINFRAME_HLQ:'Z73968',MAINFRAME_DATASET_MUTATION_SCOPE:'Z73968',MAINFRAME_JOB_CLASS:'7'};
async function fixture(options:{scenario?:'positive'|'negative'|'missing';rc?:number;missing?:boolean;badReport?:boolean;pending?:boolean;collision?:boolean;uncertain?:boolean;badStep?:boolean;trimmed?:boolean;invalidAttributes?:boolean;truncated?:boolean;replaceLine?:{index:number;value:string}}={}){
 const op=run(),root=await fs.mkdtemp(path.join(os.tmpdir(),'ledgerline-eod-'));let submitted=0,persistedIdentity=false;
 if(options.scenario){
  const missing=options.scenario==='missing',negative=options.scenario==='negative';
  const summary={transactionCount:10000,settlementCount:10000,matchedCount:negative?9990:missing?9999:10000,mismatchedCount:negative?10:0,transactionOnlyCount:missing?1:0,settlementOnlyCount:missing?1:0};
  op.inputs.transaction.recordCount=10000;op.inputs.settlement.recordCount=10000;
  const rec=op.stageResults.reconciliation as Record<string,unknown>;rec.summary=summary;rec.outcome=negative||missing?'COMPLETED_WITH_EXCEPTIONS':'COMPLETED';op.state=negative||missing?'RECONCILIATION_COMPLETED_WITH_EXCEPTIONS':'RECONCILIATION_COMPLETED';
  (rec.job as {returnCode:number}).returnCode=negative||missing?4:0;
  rec.spoolText=['VSAMCRT','VSAMLOAD','RECONCIL'].map(step=>`IEF142I JOBNAME ${step} - STEP WAS EXECUTED - COND CODE ${step==='RECONCIL'&&(negative||missing)?'0004':'0000'}`).join('\n')+`\nTRANSACTION INPUT COUNT: 10000\nSETTLEMENT INPUT COUNT: 10000\nMATCHED COUNT: ${summary.matchedCount}\nMISMATCHED COUNT: ${summary.mismatchedCount}\nTRANSACTION-ONLY COUNT: ${summary.transactionOnlyCount}\nSETTLEMENT-ONLY COUNT: ${summary.settlementOnlyCount}`;
  for(const item of op.datasets){const key=({TXNSORT:'transactionCount',SETSORT:'settlementCount',MATCHOUT:'matchedCount',MISMOUT:'mismatchedCount',TXNMISS:'transactionOnlyCount',SETMISS:'settlementOnlyCount'} as Record<string,keyof typeof summary>)[item.role]!;item.recordCount=summary[key];const output=(rec.outputs as Record<string,{recordCount:number}>)[item.role];if(output)output.recordCount=item.recordCount;}
 }
 const deps:PreflightDependencies={env,stagingRoot:root,pollAttempts:1,sleep:async()=>undefined,ownership:async()=>assert.fail('No cleanup/transfer ownership changes'),readiness:async()=>({state:'DATASET_ACCESS_VERIFIED',message:'mock'}),persist:async op=>{if((op.stageResults.eod as {jobId?:string}).jobId)persistedIdentity=true;},remote:{
 attributes:async name=>{if(!submitted&&!options.collision||submitted&&options.missing)throw Object.assign(new Error('absent'),{code:'DATASET_NOT_FOUND'});return {dsname:name,dsorg:'PS',recfm:'FB',lrecl:options.invalidAttributes?38:80};},
 create:async()=>assert.fail('No separate allocation'),upload:async()=>assert.fail('No input transfer'),
 submitJcl:async file=>{submitted++;assert.match(await fs.readFile(file,'utf8'),/COUNT FROM\(INPUT\) NOTEQUAL\(\d+\) RC8/);if(options.uncertain)throw new Error('timeout');return {jobId:'JOB12345'};},
 jobStatus:async jobId=>{assert.equal(persistedIdentity,true);return {jobId,status:options.pending?'ACTIVE':'OUTPUT',returnCode:options.pending?null:options.rc??0};},
 jobSpool:async()=>['TXNCHK','SETCHK','MATCHCT','MISCT','TNMCT','STMCT','RPTOK'].map(step=>`IEF142I EODJOB ${step} - STEP WAS EXECUTED - COND CODE ${options.badStep&&step==='MATCHCT'?'0008':'0000'}`).join('\n'),
 download:async(_name,file)=>{const actualCounts=eodCounts(op);const lines=eodReportLines(op,actualCounts,actualCounts.mismatchedCount+actualCounts.transactionOnlyCount+actualCounts.settlementOnlyCount?'HOLD':'SETTLED');if(options.badReport)lines[3]='TRANSACTIONCOUNT=999';if(options.replaceLine)lines[options.replaceLine.index]=options.replaceLine.value;await fs.writeFile(file,(options.truncated?lines.slice(0,-1):lines).map(line=>options.trimmed?line:line.padEnd(80)).join('\r\n')+'\r\n');},
 }};
 return {op,deps,root,submissions:()=>submitted};
}
test('EOD JCL uses six dynamic run-scoped count checks and gated IEBGENER report',()=>{
 const op=run(),jcl=generateSettlementJcl(op);assert.doesNotMatch(jcl,/MONETARY_TOTALS|Financial totals/);assert.equal((jcl.match(/COUNT FROM\(INPUT\)/g)??[]).length,6);assert.match(jcl,/EODRPT/);assert.match(jcl,/LRECL=80/);assert.match(jcl,/DECISION=SETTLED/);assert.match(jcl,/DECISION=HOLD/);assert.doesNotMatch(jcl,/Z73968\.BANK|ZXP\.PUBLIC|FINALCP|REPLACE/);
 const bad=run();bad.state='RECONCILIATION_FAILED';assert.throws(()=>eodCounts(bad),/Verified reconciliation/);
 (op.stageResults.reconciliation as {summary:{matchedCount:number}}).summary.matchedCount=4;assert.throws(()=>eodCounts(op),/summary/);
});
test('EOD completion requires job, all steps, exact attributes and report readback; duplicates never submit',async()=>{
 const f=await fixture();try{await executeEodSettlement(f.op,f.deps);const eod=f.op.stageResults.eod as Record<string,unknown>;assert.equal(eod.state,'COMPLETED');assert.equal(eod.decision,'SETTLED');assert.equal(eod.verified,true);assert.equal(eod.jobId,'JOB12345');assert.equal(eod.reportVersion,2);assert.doesNotMatch(String(eod.reportText),/MONETARY_TOTALS/);await executeEodSettlement(f.op,f.deps);assert.equal(f.submissions(),1);}finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('EOD holds on failed job, missing output, corrupt report, failed steps, timeout or uncertain submission',async()=>{
 for(const options of [{rc:8},{missing:true},{badReport:true},{pending:true},{uncertain:true},{badStep:true},{collision:true}]){
 const f=await fixture(options);try{await executeEodSettlement(f.op,f.deps);const eod=f.op.stageResults.eod as Record<string,unknown>;assert.notEqual(eod.state,'COMPLETED');assert.equal(eod.decision,'HOLD');assert.equal(eod.verified,false);const submitted=f.submissions();await executeEodSettlement(f.op,f.deps);assert.equal(f.submissions(),submitted);}finally{await fs.rm(f.root,{recursive:true,force:true});}
 }
});
test('disabled configuration fails before submission',async()=>{const f=await fixture();try{f.deps.env={...env,MAINFRAME_JOB_SUBMISSION_ENABLED:'false'};await executeEodSettlement(f.op,f.deps);assert.equal(f.submissions(),0);assert.equal((f.op.stageResults.eod as {decision:string}).decision,'HOLD');}finally{await fs.rm(f.root,{recursive:true,force:true});}});

test('EOD count expectations follow persisted real counts rather than smoke-test constants',()=>{
 const op=run(),rec=op.stageResults.reconciliation as {summary:Record<string,number>;outputs:Record<string,{recordCount:number}>;spoolText:string};
 for(const key of ['transactionCount','settlementCount','matchedCount'])rec.summary[key]=10000;
 rec.outputs.MATCHOUT!.recordCount=10000;rec.spoolText=rec.spoolText.replace(/COUNT: 5/g,'COUNT: 10000');
 for(const item of op.datasets)if(item.recordCount===5)item.recordCount=10000;
 const jcl=generateSettlementJcl(op);assert.match(jcl,/NOTEQUAL\(10000\)/);assert.doesNotMatch(jcl,/NOTEQUAL\(5\)/);
});

test('text-mode FB80 readback accepts omitted trailing spaces only, with strict metadata and complete report fields',async()=>{
 for(const options of [{trimmed:true},{trimmed:true,invalidAttributes:true},{trimmed:true,truncated:true},{trimmed:true,badReport:true}]){
  const f=await fixture(options);try{await executeEodSettlement(f.op,f.deps);const eod=f.op.stageResults.eod as Record<string,unknown>;assert.equal(eod.verified,!options.invalidAttributes&&!options.truncated&&!options.badReport);assert.equal(eod.decision,eod.verified?'SETTLED':'HOLD');}finally{await fs.rm(f.root,{recursive:true,force:true});}
 }
});
test('existing EOD report recovery rechecks JES and content without any remote writes or resubmission',async()=>{
 const f=await fixture({trimmed:true});try{
  await executeEodSettlement(f.op,f.deps);const eod=f.op.stageResults.eod as Record<string,unknown>;
  eod.state='FAILED';eod.decision='HOLD';eod.verified=false;eod.datasetState='UNCERTAIN';eod.failure={category:'EOD_EVIDENCE_INVALID',message:'EOD report record length is invalid.'};
  assert.equal(canVerifyExistingEod(f.op),true);
  f.deps.remote.submitJcl=async()=>assert.fail('Recovery must never submit');f.deps.remote.create=async()=>assert.fail('Recovery must never allocate');f.deps.remote.upload=async()=>assert.fail('Recovery must never upload');
  await recoverEodVerification(f.op,f.deps);const recovered=f.op.stageResults.eod as Record<string,unknown>;
  assert.equal(recovered.decision,'SETTLED');assert.equal(recovered.verified,true);assert.equal(recovered.jobId,'JOB12345');assert.equal(f.submissions(),1);assert.equal(canVerifyExistingEod(f.op),false);assert.ok(recovered.previousVerificationFailure);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('recovery retains HOLD on a changed JES result',async()=>{
 const f=await fixture();try{await executeEodSettlement(f.op,f.deps);const eod=f.op.stageResults.eod as Record<string,unknown>;eod.state='FAILED';eod.failure={category:'EOD_EVIDENCE_INVALID'};f.deps.remote.jobStatus=async jobId=>({jobId,status:'OUTPUT',returnCode:8});await recoverEodVerification(f.op,f.deps);assert.equal((f.op.stageResults.eod as {decision:string}).decision,'HOLD');assert.equal((f.op.stageResults.eod as {verified:boolean}).verified,false);assert.equal(f.submissions(),1);}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('report verification rejects inconsistent run, job, counts, disclosures or decision',async()=>{
 for(const [index,value] of [[1,'RUN=ANOTHER-RUN'],[2,'RECONCILIATION_JOB=JOB02783'],[4,'TRANSACTIONCOUNT=4'],[10,'PROCESSING_DATE=20261029'],[11,'MONETARY_TOTALS=100.00'],[12,'DECISION=HOLD']] as const){
  const f=await fixture({trimmed:true,replaceLine:{index,value}});try{await executeEodSettlement(f.op,f.deps);assert.equal((f.op.stageResults.eod as {verified:boolean}).verified,false);assert.equal((f.op.stageResults.eod as {decision:string}).decision,'HOLD');}finally{await fs.rm(f.root,{recursive:true,force:true});}
 }
});

// Captured by read-only Zowe download of Z73968.EV9R0A2L.EODRPT:
// PS/FB/80 metadata; 459 bytes of CRLF-delimited, right-unpadded text.
const capturedEodReport=[
 'LEDGERLINE EOD SETTLEMENT',
 'RUN=REC-20261028-131685A7B479021568CA',
 'RECONCILIATION_JOB=JOB00712',
 'RECONCILIATION_OUTCOME=COMPLETED',
 'TRANSACTIONCOUNT=5','SETTLEMENTCOUNT=5','MATCHEDCOUNT=5',
 'MISMATCHEDCOUNT=0','TRANSACTIONONLYCOUNT=0','SETTLEMENTONLYCOUNT=0',
 'PROCESSING_DATE=NOT AVAILABLE FROM CURRENT MAINFRAME CONTRACT',
 'MONETARY_TOTALS=UNAVAILABLE: AMOUNT IS PIC X(9); SCALE NOT VALIDATED',
 'DECISION=SETTLED',
 'REASON=ALL SIX MAINFRAME COUNTS PASSED; NO DISCREPANCIES',
].join('\r\n')+'\r\n';
test('captured 459-byte Zowe report verifies and JOB01041 recovery never resubmits',async()=>{
 assert.equal(Buffer.byteLength(capturedEodReport),459);
 const f=await fixture();try{
  await executeEodSettlement(f.op,f.deps);
  const eod=f.op.stageResults.eod as Record<string,unknown>;assert.equal(eod.verified,true);
  delete eod.reportVersion;eod.jcl=String(eod.jcl)+'\nMONETARY_TOTALS=UNAVAILABLE';
  f.deps.remote.download=async(_name,file)=>{await fs.writeFile(file,capturedEodReport);};
  eod.jobId='JOB01041';eod.job={jobId:'JOB01041',status:'OUTPUT',returnCode:0};eod.state='FAILED';eod.decision='HOLD';eod.verified=false;eod.datasetState='UNCERTAIN';eod.failure={category:'EOD_EVIDENCE_INVALID',message:'EOD report record length is invalid.'};
  f.deps.remote.submitJcl=async()=>assert.fail('Never resubmit JOB01041');
  f.deps.remote.jobStatus=async jobId=>{assert.equal(jobId,'JOB01041');return {jobId,status:'OUTPUT',returnCode:0};};
  await recoverEodVerification(f.op,f.deps);const result=f.op.stageResults.eod as Record<string,unknown>;
  assert.equal(result.jobId,'JOB01041');assert.equal(result.decision,'SETTLED');assert.equal(result.verified,true);assert.equal(f.submissions(),1);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('unpadded LF report with optional final newline preserves exact field checks',async()=>{
 for(const report of [capturedEodReport.replace(/MONETARY_TOTALS=[^\r]+\r\n/,'').replaceAll('\r\n','\n'),capturedEodReport.replace(/MONETARY_TOTALS=[^\r]+\r\n/,'').replaceAll('\r\n','\n').slice(0,-1)]){
  const f=await fixture();try{f.deps.remote.download=async(_name,file)=>{await fs.writeFile(file,report);};await executeEodSettlement(f.op,f.deps);assert.equal((f.op.stageResults.eod as {verified:boolean}).verified,true);}finally{await fs.rm(f.root,{recursive:true,force:true});}
 }
});

test('generated reconciliation and EOD JCL preserve 10K positive, amount-discrepancy and missing-record outcomes',async()=>{
 for(const scenario of ['positive','negative','missing'] as const){const f=await fixture({scenario});try{
  const reconciliation=generateReconciliationJcl(f.op.plan);assert.match(reconciliation,/IF \(VSAMCRT\.RC = 0\) THEN[\s\S]*IF \(VSAMLOAD\.RC = 0\) THEN/);assert.match(reconciliation,/TRANIN\s+DD DSN=Z73968\.EV9R0A2L\.TXNSORT/);assert.doesNotMatch(reconciliation,/REPRO[^\n]*REPLACE|Z73968\.BANK|ZXP\.PUBLIC/);
  const jcl=generateSettlementJcl(f.op),expected=scenario==='positive'?'SETTLED':'HOLD';
  assert.match(jcl,/COUNT FROM\(INPUT\) NOTEQUAL\(10000\) RC8/);
  if(scenario==='negative'){assert.match(jcl,/NOTEQUAL\(9990\) RC8/);assert.match(jcl,/NOTEQUAL\(10\) RC8/);assert.doesNotMatch(jcl,/DECISION=SETTLED/);}
  if(scenario==='missing')assert.doesNotMatch(jcl,/DECISION=SETTLED/);
  const reportBlock=jcl.slice(jcl.indexOf('//RPTOK'),jcl.indexOf('//         ELSE'));assert.ok(reportBlock.includes(`DECISION=${expected}`));
  await executeEodSettlement(f.op,f.deps);const result=f.op.stageResults.eod as Record<string,unknown>;
  assert.equal(result.verified,true);assert.equal(result.decision,expected);assert.match(String(result.reportText),new RegExp(`DECISION=${expected}`));assert.equal(result.state,'COMPLETED');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}}
});
test('unsupported or missing reconciliation RCs cannot reach EOD',()=>{
 for(const rc of [null,undefined,8,12]){const op=run();(op.stageResults.reconciliation as {job:Record<string,unknown>}).job.returnCode=rc;assert.throws(()=>eodCounts(op));}
});
