import {eodCounts} from './eodSettlement.js';
import type {BankingPreflight} from './bankingPreflight.js';
export function bankingHistory(op:BankingPreflight){
 const rec=op.stageResults.reconciliation as Record<string,unknown>|undefined,eod=op.stageResults.eod as Record<string,unknown>|undefined;
 const job=rec?.job as Record<string,unknown>|undefined;
 let verified=false;try{eodCounts(op);verified=true;}catch{ /* incomplete or contradictory evidence stays unverified */ }
 return {runId:op.runId,organizationName:op.organizationName,profile:op.profile,createdAt:op.createdAt,inputs:{transaction:{originalName:op.inputs.transaction.originalName,recordCount:op.inputs.transaction.recordCount,size:op.inputs.transaction.size},settlement:{originalName:op.inputs.settlement.originalName,recordCount:op.inputs.settlement.recordCount,size:op.inputs.settlement.size}},status:verified?(op.state==='RECONCILIATION_COMPLETED'?'COMPLETED':'BUSINESS_EXCEPTION'):op.state,summary:verified?rec?.summary:{},jobId:job?.jobId??op.jobId,jobStatus:job?.status??op.jobStatus,returnCode:job?.returnCode??op.returnCode,preflightJobId:op.jobId,preflightJob:{jobId:op.jobId,status:op.jobStatus,returnCode:op.returnCode},preflightSteps:op.stageResults.stepReturnCodes,reconciliationSteps:rec?.stepReturnCodes,eodSteps:eod?.stepReturnCodes,reconciliationJob:job,eodJob:eod?.job,eodDecision:verified&&eod?.verified===true&&eod.state==='COMPLETED'?eod.decision:'NOT_VERIFIED',datasetManifest:op.datasets,diagnostics:[...(op.errorMessage?[op.errorMessage]:[]),'Monetary totals and mainframe processing date unavailable.'],stepResults:[{stepName:'PREFLIGHT',jobId:op.jobId,status:op.jobStatus,returnCode:op.returnCode},{stepName:'RECONCILIATION',jobId:job?.jobId,status:job?.status,returnCode:job?.returnCode},{stepName:'EOD',...(eod?.job as Record<string,unknown>??{})}].filter(step=>step.jobId),operationId:op.operationId};
}
export function mergeHistory(legacy:Array<Record<string,unknown>>,banking:BankingPreflight[]){const map=new Map(legacy.map(item=>[item.runId,item]));for(const op of banking)map.set(op.runId,bankingHistory(op));return [...map.values()];}

export function verifiedEodText(op:BankingPreflight):string|undefined {
 const eod=op.stageResults.eod as {verified?:boolean;state?:string;reportText?:unknown}|undefined;
 return eod?.verified===true&&eod.state==='COMPLETED'&&typeof eod.reportText==='string'&&eod.reportText.length>0?eod.reportText:undefined;
}
