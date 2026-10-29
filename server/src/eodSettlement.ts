import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { countConsistencyError, parseCobolCounts, type CobolCounts } from './executionPlan.js';
import type { BankingPreflight, PreflightDependencies } from './bankingPreflight.js';
import { sanitizeText } from './observability.js';

const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const CHECKS=[['TXNCHK','TXNSORT','transactionCount'],['SETCHK','SETSORT','settlementCount'],['MATCHCT','MATCHOUT','matchedCount'],['MISCT','MISMOUT','mismatchedCount'],['TNMCT','TXNMISS','transactionOnlyCount'],['STMCT','SETMISS','settlementOnlyCount']] as const;
const error=(message:string,code='EOD_EVIDENCE_INVALID'):never=>{throw Object.assign(new Error(message),{code});};

export function eodCounts(op:BankingPreflight):CobolCounts {
  const rec=obj(op.stageResults.reconciliation),job=obj(rec.job);
  if(!['RECONCILIATION_COMPLETED','RECONCILIATION_COMPLETED_WITH_EXCEPTIONS'].includes(op.state)||rec.failure||job.status!=='OUTPUT'||![0,4].includes(Number(job.returnCode))||typeof job.jobId!=='string'||!/^JOB\d+$/i.test(job.jobId)||typeof rec.spoolText!=='string')return error('Verified reconciliation and terminal JES evidence are required.');
  if(rec.outcome!==(op.state==='RECONCILIATION_COMPLETED'?'COMPLETED':'COMPLETED_WITH_EXCEPTIONS'))return error('Reconciliation outcome does not agree with its saved state.');
  const counts=parseCobolCounts(rec.spoolText);
  if(countConsistencyError(counts)||Object.entries(counts).some(([key,value])=>obj(rec.summary)[key]!==value))return error('Saved summary does not agree with COBOL spool.');
  for(const step of ['VSAMCRT','VSAMLOAD','RECONCIL']){
    const matches=[...rec.spoolText.matchAll(new RegExp(`\\bIEF142I\\s+\\S+\\s+${step}\\s+-[^\\n]*COND CODE\\s+(\\d{4})`,'g'))];
    if(matches.length!==1||Number(matches[0]![1])!==(step==='RECONCIL'?job.returnCode:0))return error('Required reconciliation step evidence is missing or contradictory.');
  }
  const exceptions=counts.mismatchedCount+counts.transactionOnlyCount+counts.settlementOnlyCount;
  if((job.returnCode===0&&exceptions!==0)||(job.returnCode===4&&exceptions===0))return error('Reconciliation RC contradicts discrepancy counts.');
  for(const [role,key] of [['MATCHOUT','matchedCount'],['MISMOUT','mismatchedCount'],['TXNMISS','transactionOnlyCount'],['SETMISS','settlementOnlyCount']] as const){
    const output=obj(obj(rec.outputs)[role]);
    if(output.verified!==true||output.dataset!==op.plan.datasets[role]||output.recordCount!==counts[key])return error('Verified physical output evidence is missing.');
  }
  for(const [,role,key] of CHECKS){
    const name=op.plan.datasets[role];
    if(name!==`Z73968.${op.runQualifier}.${role}`||!op.datasets.some(item=>item.name===name&&item.role===role&&item.state==='CREATED'&&item.recordCount===counts[key]))return error('Run manifest does not confirm the expected count and exact dataset.');
  }
  return counts;
}

export function eodReportLines(op:BankingPreflight,counts:CobolCounts,decision:'SETTLED'|'HOLD',version:1|2=2):string[]{
  return ['LEDGERLINE EOD SETTLEMENT',`RUN=${op.runId}`,`RECONCILIATION_JOB=${obj(obj(op.stageResults.reconciliation).job).jobId}`,`RECONCILIATION_OUTCOME=${obj(op.stageResults.reconciliation).outcome}`,
    ...Object.entries(counts).map(([key,value])=>`${key.toUpperCase()}=${value}`),
    'PROCESSING_DATE=NOT AVAILABLE FROM CURRENT MAINFRAME CONTRACT',
    ...(version===1?['MONETARY_TOTALS=UNAVAILABLE: AMOUNT IS PIC X(9); SCALE NOT VALIDATED']:[]),
    `DECISION=${decision}`,decision==='SETTLED'?'REASON=ALL SIX MAINFRAME COUNTS PASSED; NO DISCREPANCIES':'REASON=DISCREPANCIES OR MAINFRAME COUNT/UTILITY CHECK FAILED'];
}

export function generateSettlementJcl(op:BankingPreflight):string {
  const counts=eodCounts(op),plan=op.plan;
  if(!/^[A-Z][A-Z0-9]{0,7}$/.test(plan.jobName)||!/^[A-Z0-9]$/.test(plan.config.jobClass)||!/^REC-[A-Z0-9-]+$/.test(op.runId)||!/^Z73968\.[A-Z][A-Z0-9]{7}\.MATCHOUT$/.test(plan.datasets.MATCHOUT))return error('Invalid run JCL parameters.');
  const report=(step:string,decision:'SETTLED'|'HOLD')=>[`//${step.padEnd(8)} EXEC PGM=IEBGENER`,'//SYSPRINT DD SYSOUT=*','//SYSIN    DD DUMMY','//SYSUT1   DD *',...eodReportLines(op,counts,decision).map(line=>line.padEnd(80)),'/*',`//SYSUT2   DD DSN=Z73968.${op.runQualifier}.EODRPT,`, '//         DISP=(NEW,CATLG,KEEP),SPACE=(TRK,(1,1)),UNIT=SYSDA,','//         DCB=(DSORG=PS,RECFM=FB,LRECL=80,BLKSIZE=0)'].join('\n');
  const checks=CHECKS.map(([step,role,key])=>[`//${step.padEnd(8)} EXEC PGM=ICETOOL`,'//TOOLMSG  DD SYSOUT=*','//DFSMSG   DD SYSOUT=*',`//INPUT    DD DSN=${plan.datasets[role]},DISP=SHR`,'//TOOLIN   DD *',`  COUNT FROM(INPUT) NOTEQUAL(${counts[key]}) RC8`,'/*'].join('\n'));
  const clean=counts.mismatchedCount+counts.transactionOnlyCount+counts.settlementOnlyCount===0;
  const jcl=[`//${plan.jobName} JOB ,MSGLEVEL=(2,0),CLASS=${plan.config.jobClass}`,...checks,
    '//EODOK    IF (TXNCHK.RC = 0 & SETCHK.RC = 0 & MATCHCT.RC = 0 &',
    '//         MISCT.RC = 0 & TNMCT.RC = 0 & STMCT.RC = 0) THEN',report('RPTOK',clean?'SETTLED':'HOLD'),'//         ELSE',report('RPTHOLD','HOLD'),'//         ENDIF'].join('\n')+'\n';
  if(jcl.split('\n').some(line=>line.length>80)||/ZXP\.PUBLIC|Z73968\.BANK|REPLACE/.test(jcl))return error('Generated EOD JCL failed static safety checks.');
  return jcl;
}

export async function executeEodSettlement(op:BankingPreflight,deps:PreflightDependencies):Promise<BankingPreflight>{
  const previous=obj(op.stageResults.eod);
  if(previous.state&&previous.state!=='REQUESTED')return op;
  const eod:Record<string,unknown>={reportVersion:2,state:'PREFLIGHT',decision:'HOLD',dataset:`Z73968.${op.runQualifier}.EODRPT`,datasetState:'PLANNED',startedAt:new Date()};
  op.stageResults.eod=eod;
  const save=()=>deps.persist(op);let invoked=false;const local=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.jcl`),download=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.out`);
  try{
    const counts=eodCounts(op),jcl=generateSettlementJcl(op);eod.counts=counts;eod.jcl=jcl;await save();
    const env=deps.env;
    if(['MAINFRAME_ENABLED','MAINFRAME_AUTH_READY','MAINFRAME_RECONCILIATION_ENABLED','MAINFRAME_JOB_SUBMISSION_ENABLED','MAINFRAME_DATASET_MUTATIONS_ENABLED','MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED'].some(key=>env[key]!=='true')||env.MAINFRAME_HLQ!=='Z73968'||env.MAINFRAME_DATASET_MUTATION_SCOPE!=='Z73968'||env.MAINFRAME_JOB_CLASS!==op.plan.config.jobClass)return error('Existing execution gates are not satisfied.','EOD_DISABLED');
    if((await deps.readiness()).state!=='DATASET_ACCESS_VERIFIED')return error('Mainframe readiness did not pass.','EOD_READINESS_FAILED');
    try{await deps.remote.attributes(String(eod.dataset));return error('EODRPT already exists; no overwrite is permitted.','DATASET_COLLISION');}catch(e){if((e as {code?:string}).code!=='DATASET_NOT_FOUND')throw e;}
    await fs.mkdir(path.resolve(deps.stagingRoot),{recursive:true});await fs.writeFile(local,jcl,{flag:'wx',mode:0o600});
    eod.state='SUBMITTING';eod.datasetState='UNCERTAIN';await save();invoked=true;
    const submitted=await deps.remote.submitJcl(local);
    if(!/^JOB\d+$/i.test(submitted.jobId))return error('Submission did not return an exact JES identity.','EOD_SUBMISSION_UNCERTAIN');
    eod.jobId=submitted.jobId;eod.state='RUNNING';await save();
    let status:Awaited<ReturnType<typeof deps.remote.jobStatus>>|undefined;
    const attempts=deps.pollAttempts??40;
    if(!Number.isInteger(attempts)||attempts<1||attempts>60)return error('Invalid polling bound.');
    for(let i=0;i<attempts;i++){
      status=await deps.remote.jobStatus(submitted.jobId);
      if(status.jobId!==submitted.jobId)return error('JES returned another job identity.');
      eod.job=status;await save();if(status.status==='OUTPUT')break;
      if(['ABEND','CANCELED','CANCELLED','JCL ERROR'].includes(status.status))return error('EOD JES job failed.','EOD_JOB_FAILED');
      if(i+1<attempts)await (deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(deps.pollIntervalMs??1500);
    }
    if(status?.status!=='OUTPUT')return error('EOD outcome remains unresolved; never resubmit.','EOD_TIMEOUT');
    const spool=await deps.remote.jobSpool(submitted.jobId);eod.spoolText=spool.split(/\r?\n/).map(line=>sanitizeText(line,4000)).join('\n').slice(0,1_000_000);await save();
    await verifyEodEvidence(op,deps,eod,status,spool,download,counts);
  }catch(e){if(obj(eod.job).status==='OUTPUT'&&obj(eod.job).returnCode===0)eod.batchStatus='COMPLETED';eod.state=invoked&&(!eod.jobId||!['OUTPUT','ABEND','CANCELED','CANCELLED','JCL ERROR'].includes(String(obj(eod.job).status)))?'UNRESOLVED':'FAILED';eod.decision='HOLD';eod.verified=false;eod.failure={category:sanitizeText((e as {code?:string}).code??'EOD_FAILED',80),message:sanitizeText((e as Error).message,240)};
  }finally{await fs.unlink(local).catch(()=>undefined);await fs.unlink(download).catch(()=>undefined);await save();}
  return op;
}

async function verifyEodEvidence(op:BankingPreflight,deps:PreflightDependencies,eod:Record<string,unknown>,status:Awaited<ReturnType<PreflightDependencies['remote']['jobStatus']>>,spool:string,download:string,counts:CobolCounts):Promise<void>{
 const version:1|2=eod.reportVersion===2?2:eod.reportVersion===1||typeof eod.jcl==='string'&&eod.jcl.includes('MONETARY_TOTALS=UNAVAILABLE')?1:2;
 if(status.jobId!==eod.jobId||status.status!=='OUTPUT')return error('EOD job identity or terminal status does not match.');
    const stepCodes:Record<string,number>={};
    for(const match of spool.matchAll(/\bIEF142I\s+\S+\s+(TXNCHK|SETCHK|MATCHCT|MISCT|TNMCT|STMCT|RPTOK|RPTHOLD)\s+-[^\n]*COND CODE\s+(\d{4})/g)){
      if(stepCodes[match[1]!]!==undefined)return error('Duplicate EOD step evidence.');stepCodes[match[1]!]=Number(match[2]);
    }
    eod.stepReturnCodes=stepCodes;
    if(status.returnCode!==0||CHECKS.some(([step])=>stepCodes[step]!==0)||stepCodes.RPTOK!==0||stepCodes.RPTHOLD!==undefined)return error('Required EOD count/report steps failed.','EOD_JOB_FAILED');
    const attributes=await deps.remote.attributes(String(eod.dataset));eod.attributes=attributes;
    if(attributes.dsname.toUpperCase()!==eod.dataset||attributes.dsorg?.toUpperCase()!=='PS'||attributes.recfm?.toUpperCase()!=='FB'||Number(attributes.lrecl)!==80)return error('EODRPT must verify as exact PS/FB/80.');
    await deps.remote.download(String(eod.dataset),download);
    if((await fs.stat(download)).size>eodReportLines(op,counts,'HOLD',version).length*82)return error('EOD report exceeds its bounded expected representation.');
    const bytes=await fs.readFile(download);
    if(bytes.some(byte=>byte!==10&&byte!==13&&(byte<32||byte>126)))return error('EOD report encoding is invalid.');
    const lines=bytes.toString('ascii').replace(/\r\n/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
    eod.readbackRepresentation={bytes:bytes.length,lineLengths:lines.map(line=>line.length),mode:'ZOWE_TEXT',physicalLrecl:80};
    if(lines.some(line=>line.length>80))return error('EOD text record exceeds physical LRECL 80.');
    const decision=counts.mismatchedCount+counts.transactionOnlyCount+counts.settlementOnlyCount===0?'SETTLED':'HOLD';
    if(JSON.stringify(lines.map(line=>line.replace(/ +$/,'')))!==JSON.stringify(eodReportLines(op,counts,decision,version)))return error('Downloaded report does not match verified run/count evidence.');
    eod.reportText=lines.map(line=>line.trimEnd()).join('\n');eod.reportSha256=crypto.createHash('sha256').update(bytes).digest('hex');eod.datasetState='VERIFIED';eod.decision=decision;eod.state='COMPLETED';eod.verified=true;eod.completedAt=new Date();eod.batchStatus='COMPLETED';delete eod.failure;
}

export function canVerifyExistingEod(op:Pick<BankingPreflight,'stageResults'|'runQualifier'>):boolean{
 const eod=obj(op.stageResults.eod),job=obj(eod.job),steps=obj(eod.stepReturnCodes),failure=obj(eod.failure);
 return eod.state==='FAILED'&&failure.category==='EOD_EVIDENCE_INVALID'&&typeof eod.jobId==='string'&&/^JOB\d+$/i.test(eod.jobId)&&job.jobId===eod.jobId&&job.status==='OUTPUT'&&job.returnCode===0&&eod.dataset===`Z73968.${op.runQualifier}.EODRPT`&&CHECKS.every(([step])=>steps[step]===0)&&steps.RPTOK===0&&steps.RPTHOLD===undefined&&typeof eod.spoolText==='string';
}
/** Verification only: no submission, allocation, upload or remote cleanup. */
export async function recoverEodVerification(op:BankingPreflight,deps:PreflightDependencies):Promise<BankingPreflight>{
 if(!canVerifyExistingEod(op))return error('No eligible failed EOD report verification exists.','EOD_RECOVERY_BLOCKED');
 const eod=structuredClone(obj(op.stageResults.eod)),download=path.join(path.resolve(deps.stagingRoot),`${crypto.randomUUID()}.out`);
 eod.previousVerificationFailure=eod.failure;eod.decision='HOLD';eod.verified=false;
 try{
  const counts=eodCounts(op),jobId=String(eod.jobId);
  const status=await deps.remote.jobStatus(jobId);const spool=await deps.remote.jobSpool(jobId);
  // Preserve original batch evidence; the new query is associated with the same exact job.
  eod.verificationJob=status;eod.verificationSpoolText=spool.split(/\r?\n/).map(line=>sanitizeText(line,4000)).join('\n').slice(0,1_000_000);
  await fs.mkdir(path.resolve(deps.stagingRoot),{recursive:true});
  await verifyEodEvidence(op,deps,eod,status,spool,download,counts);
 }catch(e){eod.state='FAILED';eod.decision='HOLD';eod.verified=false;eod.failure={category:sanitizeText((e as {code?:string}).code??'EOD_VERIFICATION_FAILED',80),message:sanitizeText((e as Error).message,240)};
 }finally{await fs.unlink(download).catch(()=>undefined);eod.verificationCheckedAt=new Date();op.stageResults.eod=eod;await deps.persist(op);}
 return op;
}
