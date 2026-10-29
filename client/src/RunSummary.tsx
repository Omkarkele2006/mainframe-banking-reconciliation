import React from 'react';
type Job={jobId?:string;status?:string;returnCode?:number};
export type SummaryRun={runId:string;preflightJobId?:string;preflightJob?:Job;reconciliationJob?:Job;eodJob?:Job;jobId?:string;jobStatus?:string;returnCode?:number;eodDecision?:string;createdAt:string};
export function OutcomeHeading({count}:{count:number}){return <h3>Verified outcomes: {count} visible saved {count===1?'run':'runs'}</h3>;}
export function RunSummary({run}:{run:SummaryRun}){
 const rec=run.reconciliationJob??(run.preflightJob||run.preflightJobId?undefined:{jobId:run.jobId,status:run.jobStatus,returnCode:run.returnCode});
 const job=(value:Job|undefined,fallback?:string)=><React.Fragment><code>{value?.jobId??fallback??'Not confirmed'}</code><span>Status: {value?.status??'Not available'}</span><span>RC: {value?.returnCode??'Not available'}</span></React.Fragment>;
 const timestamp=Date.parse(run.createdAt);
 return <dl className="run-summary-fields"><div><dt>Run ID</dt><dd><code>{run.runId}</code></dd></div><div><dt>Preflight job</dt><dd>{job(run.preflightJob,run.preflightJobId)}</dd></div><div><dt>Reconciliation job</dt><dd>{job(rec)}</dd></div><div><dt>EOD job</dt><dd>{job(run.eodJob)}</dd></div><div><dt>EOD decision</dt><dd><strong>{run.eodDecision??'Not verified'}</strong></dd></div><div><dt>Submitted</dt><dd>{Number.isNaN(timestamp)?'Not available':<time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleString()}</time>}</dd></div></dl>;
}
