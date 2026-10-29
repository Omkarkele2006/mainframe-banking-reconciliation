import assert from 'node:assert/strict';
import test from 'node:test';
import { canVerifyEodReport, canRunEodSettlement, canVerifyExistingOutputs, createOutputVerificationAction, canContinueToVsamCobol, shouldShowVsamCobolAction } from './bankingPreflightUi.js';

test('reports continuation action is available only for a ready persisted preflight and open server gates', () => {
  assert.equal(shouldShowVsamCobolAction('READY_FOR_RECONCILIATION'), true);
  assert.equal(canContinueToVsamCobol('READY_FOR_RECONCILIATION', true, false), true);
  assert.equal(canContinueToVsamCobol('READY_FOR_RECONCILIATION', false, false), false);
  assert.equal(canContinueToVsamCobol('READY_FOR_RECONCILIATION', true, true), false);
  for (const state of ['RECONCILIATION_PREFLIGHT', 'VSAM_COBOL_RUNNING', 'RECONCILIATION_BLOCKED', 'RECONCILIATION_UNRESOLVED', 'RECONCILIATION_COMPLETED']) {
    assert.equal(shouldShowVsamCobolAction(state), false, `${state} must not offer another submission`);
  }
  assert.equal(shouldShowVsamCobolAction('RECONCILIATION_BLOCKED', true), true);
  assert.equal(canContinueToVsamCobol('RECONCILIATION_BLOCKED', true, false, true), true);
  assert.equal(canContinueToVsamCobol('RECONCILIATION_BLOCKED', false, false, true), false);
});

 test('terminal syntax recovery action requires server-confirmed eligibility',()=>{
  assert.equal(shouldShowVsamCobolAction('RECONCILIATION_FAILED',true),true);
  assert.equal(shouldShowVsamCobolAction('RECONCILIATION_FAILED',false),false);
  assert.equal(shouldShowVsamCobolAction('RECONCILIATION_UNRESOLVED',true),false);
});

const eligible=()=>({operationId:'saved-operation',state:'RECONCILIATION_FAILED',stageResults:{reconciliation:{job:{jobId:'JOB00712',status:'OUTPUT',returnCode:0},stepReturnCodes:{VSAMCRT:0,VSAMLOAD:0,RECONCIL:0},spoolText:'saved actual spool',failure:{stage:'VSAM_AND_OUTPUT_DATASET_VERIFICATION'}}}});
test('verification action calls only the verification endpoint and refreshes persisted evidence',async()=>{
 const run=eligible();let refreshed='';const result=await createOutputVerificationAction()(run,async url=>{assert.equal(url,'/api/mainframe/reconciliation-preflight/saved-operation/verify-outputs');return {...run,state:'RECONCILIATION_COMPLETED',stageResults:{reconciliation:{outcome:'COMPLETED'}}};},async id=>{refreshed=id;});assert.equal(result?.success,true);assert.equal(refreshed,run.operationId);
});
test('verification failure stays unverified with detailed checks and refreshes after request errors',async()=>{
 const run=eligible();let refreshes=0;const action=createOutputVerificationAction();
 const result=await action(run,async()=>({...run,stageResults:{reconciliation:{failure:{category:'COUNT_MISMATCH',message:'MATCHOUT count differs'}}}}),async()=>{refreshes++;});assert.equal(result?.success,false);assert.match(result!.message,/COUNT_MISMATCH.*MATCHOUT/);
 await assert.rejects(()=>action(run,async()=>{throw new Error('Denied');},async()=>{refreshes++;}),/Denied/);assert.equal(refreshes,2);
});
test('verification prevents duplicate clicks while the request or refresh is pending',async()=>{
 const run=eligible(),action=createOutputVerificationAction();let release!:()=>void,calls=0;const wait=new Promise<void>(resolve=>{release=resolve;});
 const request=async()=>{calls++;await wait;return run;};const first=action(run,request,async()=>undefined);assert.equal(await action(run,request,async()=>undefined),undefined);release();await first;assert.equal(calls,1);
});
test('ineligible runs never invoke verification',async()=>{
 for(const state of ['READY_FOR_RECONCILIATION','RECONCILIATION_UNRESOLVED','RECONCILIATION_COMPLETED']){const run={...eligible(),state};assert.equal(canVerifyExistingOutputs(run),false);await createOutputVerificationAction()(run,async()=>{assert.fail('request must not run');},async()=>undefined);}
 const run=eligible();run.stageResults.reconciliation.job.returnCode=12;assert.equal(canVerifyExistingOutputs(run),false);
});

test('EOD action needs verified outputs and open gates and cannot repeat a saved attempt',()=>{
 const run={...eligible(),state:'RECONCILIATION_COMPLETED',stageResults:{reconciliation:{job:{status:'OUTPUT',returnCode:0},outputs:Object.fromEntries(['MATCHOUT','MISMOUT','TXNMISS','SETMISS'].map(role=>[role,{verified:true}]))}}};
 assert.equal(canRunEodSettlement(run,true,false),true);assert.equal(canRunEodSettlement(run,false,false),false);assert.equal(canRunEodSettlement(run,true,true),false);
 assert.equal(canRunEodSettlement({...run,stageResults:{...run.stageResults,eod:{state:'UNRESOLVED'}}},true,false),false);
 assert.equal(canRunEodSettlement({...run,state:'RECONCILIATION_FAILED'},true,false),false);
});

test('EOD verification action is limited to failed report verification after a successful existing batch',()=>{
 const run={...eligible(),stageResults:{eod:{state:'FAILED',jobId:'JOB01041',job:{jobId:'JOB01041',status:'OUTPUT',returnCode:0},failure:{category:'EOD_EVIDENCE_INVALID'},stepReturnCodes:{TXNCHK:0,SETCHK:0,MATCHCT:0,MISCT:0,TNMCT:0,STMCT:0,RPTOK:0}}}};
 assert.equal(canVerifyEodReport(run),true);run.stageResults.eod.job.returnCode=8;assert.equal(canVerifyEodReport(run),false);run.stageResults.eod.job.returnCode=0;run.stageResults.eod.job.jobId='JOB02783';assert.equal(canVerifyEodReport(run),false);
});
