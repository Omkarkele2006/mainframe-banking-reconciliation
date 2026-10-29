import {makeTenKDemoInputs} from './demoFixtures.js';
import {validateDatasetUpload} from './datasetLifecycle.js';
import test from 'node:test';import assert from 'node:assert/strict';import {verifiedEodText,mergeHistory,bankingHistory} from './demoReports.js';import type {BankingPreflight} from './bankingPreflight.js';
const summary={transactionCount:10000,settlementCount:10000,matchedCount:9990,mismatchedCount:10,transactionOnlyCount:0,settlementOnlyCount:0};
const datasets=Object.fromEntries(['TXNSORT','SETSORT','MATCHOUT','MISMOUT','TXNMISS','SETMISS'].map(role=>[role,`Z73968.ABC12345.${role}`]));
const countsByRole={TXNSORT:10000,SETSORT:10000,MATCHOUT:9990,MISMOUT:10,TXNMISS:0,SETMISS:0};
const op={runId:'REC-1',runQualifier:'ABC12345',state:'RECONCILIATION_COMPLETED_WITH_EXCEPTIONS',plan:{datasets},inputs:{transaction:{originalName:'txn',recordCount:10000},settlement:{originalName:'set',recordCount:10000}},datasets:Object.entries(countsByRole).map(([role,recordCount])=>({role,name:datasets[role],recordCount,state:'CREATED'})),stageResults:{reconciliation:{outcome:'COMPLETED_WITH_EXCEPTIONS',job:{jobId:'JOB2',status:'OUTPUT',returnCode:4},summary,spoolText:'IEF142I R VSAMCRT - COND CODE 0000\nIEF142I R VSAMLOAD - COND CODE 0000\nIEF142I R RECONCIL - COND CODE 0004\nTRANSACTION INPUT COUNT: 10000\nSETTLEMENT INPUT COUNT: 10000\nMATCHED COUNT: 9990\nMISMATCHED COUNT: 10\nTRANSACTION-ONLY COUNT: 0\nSETTLEMENT-ONLY COUNT: 0',outputs:Object.fromEntries(['MATCHOUT','MISMOUT','TXNMISS','SETMISS'].map(role=>[role,{verified:true,dataset:datasets[role],recordCount:countsByRole[role as keyof typeof countsByRole]}]))},eod:{verified:true,state:'COMPLETED',decision:'HOLD'}}} as unknown as BankingPreflight;

test('history deduplicates by persisted run ID and preserves business RC4 evidence',()=>{const items=mergeHistory([{runId:'REC-1',status:'NOT_CONFIGURED'}],[op]);assert.equal(items.length,1);assert.equal(items[0]!.status,'BUSINESS_EXCEPTION');assert.equal(items[0]!.returnCode,4);assert.equal(items[0]!.eodDecision,'HOLD');assert.equal((bankingHistory(op).summary as {matchedCount:number}).matchedCount,9990);});
test('empty history and unverified runs do not fabricate counts or settlement',()=>{assert.deepEqual(mergeHistory([],[]),[]);const value=bankingHistory({...op,state:'RECONCILIATION_FAILED',stageResults:{}});assert.deepEqual(value.summary,{});assert.equal(value.eodDecision,'NOT_VERIFIED');});

test('10K positive and ten-amount-change negative intake both retain the 38-byte contract',()=>{
 const rows=Array.from({length:10000},(_,i)=>`${String(i+1).padStart(10,'0')}ACCOUNT00100000125020261028A`);
 const negative=rows.map((row,i)=>i<10?row.slice(0,20)+'000001251'+row.slice(29):row);
 for(const records of [rows,negative]){const result=validateDatasetUpload(Buffer.from(records.join('\r\n')+'\r\n','ascii'));assert.equal(result.recordCount,10000);assert.deepEqual(result.records,records);}
 assert.equal(negative.filter((row,i)=>row!==rows[i]).length,10);
});

test('EOD download returns only persisted verified readback and refuses failed or absent reports',()=>{
 const saved={...op,stageResults:{eod:{verified:true,state:'COMPLETED',reportText:'actual saved mainframe text\n'}}};assert.equal(verifiedEodText(saved),'actual saved mainframe text\n');assert.equal(verifiedEodText({...saved,stageResults:{eod:{...saved.stageResults.eod,verified:false}}}),undefined);assert.equal(verifiedEodText({...op,stageResults:{}}),undefined);
});

test('reusable demo generator produces exact 10K pairs with only ten amount-field differences',()=>{
 for(const negative of [false,true]){const pair=makeTenKDemoInputs(negative),txn=validateDatasetUpload(pair.transaction),set=validateDatasetUpload(pair.settlement);assert.equal(txn.recordCount,10000);assert.equal(set.recordCount,10000);const changed=txn.records.map((row,index)=>({row,other:set.records[index]!})).filter(({row,other})=>row!==other);assert.equal(changed.length,negative?10:0);for(const {row,other} of changed){assert.equal(row.slice(0,20),other.slice(0,20));assert.equal(row.slice(29),other.slice(29));assert.notEqual(row.slice(20,29),other.slice(20,29));}}
});

test('history suppresses counts and settlement when terminal labels contradict JES evidence',()=>{
 const invalid=structuredClone(op);(invalid.stageResults.reconciliation as {job:{returnCode:number}}).job.returnCode=0;const report=bankingHistory(invalid);assert.deepEqual(report.summary,{});assert.equal(report.eodDecision,'NOT_VERIFIED');
});
