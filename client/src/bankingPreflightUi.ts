export function shouldShowVsamCobolAction(state: string, canResumeLoadModule = false): boolean {
  return state === 'READY_FOR_RECONCILIATION' || (['RECONCILIATION_BLOCKED', 'RECONCILIATION_FAILED'].includes(state) && canResumeLoadModule);
}

export function canContinueToVsamCobol(state: string, reconciliationEnabled: boolean, busy: boolean, canResumeLoadModule = false): boolean {
  return shouldShowVsamCobolAction(state, canResumeLoadModule) && reconciliationEnabled && !busy;
}

export type OutputVerificationRun = {operationId:string;state:string;stageResults:Record<string,unknown>};
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function canVerifyExistingOutputs(run:OutputVerificationRun):boolean {
 const evidence=record(run.stageResults.reconciliation),job=record(evidence.job),failure=record(evidence.failure),steps=record(evidence.stepReturnCodes);
 return run.state==='RECONCILIATION_FAILED'&&failure.stage==='VSAM_AND_OUTPUT_DATASET_VERIFICATION'&&job.status==='OUTPUT'&&job.returnCode===0&&typeof job.jobId==='string'&&/^JOB\d+$/i.test(job.jobId)&&typeof evidence.spoolText==='string'&&evidence.spoolText.trim().length>0&&['VSAMCRT','VSAMLOAD','RECONCIL'].every(step=>steps[step]===0);
}
export function createOutputVerificationAction(){
 let pending=false;
 return async(run:OutputVerificationRun,request:(url:string)=>Promise<OutputVerificationRun>,refresh:(id:string)=>Promise<unknown>):Promise<{success:boolean;message:string}|undefined>=>{
  if(pending||!canVerifyExistingOutputs(run))return undefined;
  pending=true;
  try{
   const result=await request(`/api/mainframe/reconciliation-preflight/${encodeURIComponent(run.operationId)}/verify-outputs`);
   const evidence=record(result.stageResults.reconciliation),failure=record(evidence.failure);
   const success=result.state==='RECONCILIATION_COMPLETED'&&evidence.outcome==='COMPLETED'&&!evidence.failure;
   return {success,message:success?'Existing outputs verified. All required checks passed.':`Outputs remain unverified. ${typeof failure.category==='string'?failure.category+': ':''}${typeof failure.message==='string'?failure.message:'Required checks were not confirmed. Review persisted evidence.'}`};
  }finally{try{await refresh(run.operationId);}finally{pending=false;}}
 };
}

export function canRunEodSettlement(run:OutputVerificationRun,enabled:boolean,busy:boolean):boolean {
 const rec=record(run.stageResults.reconciliation),job=record(rec.job),outputs=record(rec.outputs);
 return enabled&&!busy&&!run.stageResults.eod&&!rec.failure&&['RECONCILIATION_COMPLETED','RECONCILIATION_COMPLETED_WITH_EXCEPTIONS'].includes(run.state)&&job.status==='OUTPUT'&&[0,4].includes(Number(job.returnCode))&&['MATCHOUT','MISMOUT','TXNMISS','SETMISS'].every(role=>record(outputs[role]).verified===true);
}

export function canVerifyEodReport(run:OutputVerificationRun):boolean {
 const eod=record(run.stageResults.eod),job=record(eod.job),failure=record(eod.failure),steps=record(eod.stepReturnCodes);
 return eod.state==='FAILED'&&failure.category==='EOD_EVIDENCE_INVALID'&&typeof eod.jobId==='string'&&job.jobId===eod.jobId&&job.status==='OUTPUT'&&job.returnCode===0&&['TXNCHK','SETCHK','MATCHCT','MISCT','TNMCT','STMCT','RPTOK'].every(step=>steps[step]===0)&&steps.RPTHOLD===undefined;
}
