import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import fs from 'node:fs';
import {RunSummary,OutcomeHeading} from './RunSummary.js';
test('dashboard headings are readable UTF-8 with correct singular and plural',()=>{
 for(const count of [0,1,2]){const html=renderToStaticMarkup(React.createElement(OutcomeHeading,{count}));assert.doesNotMatch(html,/\uFFFD/);assert.match(html,new RegExp(`${count} visible saved ${count===1?'run</h3>':'runs</h3>'}`));}
 const bytes=fs.readFileSync(new URL('./App.tsx',import.meta.url));assert.doesNotThrow(()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes));assert.doesNotMatch(bytes.toString('utf8'),/\uFFFD/);
});
test('run summary renders each job, RC, decision and timestamp in distinct labeled fields',()=>{
 const html=renderToStaticMarkup(React.createElement(RunSummary,{run:{runId:'REC-SAVED',createdAt:'2026-10-28T12:00:00Z',preflightJob:{jobId:'JOB02783',status:'OUTPUT',returnCode:0},reconciliationJob:{jobId:'JOB00712',status:'OUTPUT',returnCode:0},eodJob:{jobId:'JOB01041',status:'OUTPUT',returnCode:0},eodDecision:'SETTLED'}}));
 assert.equal((html.match(/<dt>/g)??[]).length,6);assert.equal((html.match(/<dd>/g)??[]).length,6);
 for(const text of ['Run ID','Preflight job','Reconciliation job','EOD job','EOD decision','Submitted','JOB02783','JOB00712','JOB01041','SETTLED'])assert.ok(html.includes(text));
 assert.equal((html.match(/RC: 0/g)??[]).length,3);assert.match(html,/<time dateTime=/);assert.doesNotMatch(html,/\uFFFD/);
 const css=fs.readFileSync(new URL('./styles.css',import.meta.url),'utf8');assert.match(css,/\.run-summary-fields[^{]*\{[^}]*display:grid/);assert.match(css,/\.run-summary-fields dd[^{]*\{[^}]*gap:/);
});

test('preflight-only run does not relabel the preflight job as a reconciliation job',()=>{
 const html=renderToStaticMarkup(React.createElement(RunSummary,{run:{runId:'REC-PENDING',createdAt:'2026-10-28',preflightJobId:'JOB02783',jobId:'JOB02783'}}));assert.equal((html.match(/JOB02783/g)??[]).length,1);assert.match(html,/<dt>Reconciliation job<\/dt><dd><code>Not confirmed/);
});
