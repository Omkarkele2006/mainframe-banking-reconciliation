import assert from 'node:assert/strict';
import test from 'node:test';
import { createZoweUploadAdapter } from './zoweUploadAdapter.js';

test('maps RFJ dataset attributes and allocation into validated typed operations', async () => {
  const calls: string[][] = [];
  const responses = [
    { success:true, exitCode:0, message:'Completed.', stdout:'', stderr:'', data:{ success:true, apiResponse:{ items:[{ dsname:'Z73968.UABC1234.TXNIN', dsorg:'PS', recfm:'FB', lrecl:'38' }] } } },
    { success:true, exitCode:0, message:'Created.', stdout:'', stderr:'', data:{ success:true, apiResponse:{ dsname:'Z73968.UABC1234.TXNIN' } } },
  ];
  const adapter = createZoweUploadAdapter({ platform:'win32', env:{ PATH:'C:\\zowe' }, locate:async()=> 'C:\\zowe\\zowe.cmd', invoke:async(_executable,args)=>{ calls.push(args); return { exitCode:0, stdout:JSON.stringify(responses.shift()), stderr:'' }; } });
  assert.deepEqual(await adapter.attributes('Z73968.UABC1234.TXNIN'),{ dsname:'Z73968.UABC1234.TXNIN', dsorg:'PS', recfm:'FB', lrecl:38 });
  await adapter.create('Z73968.UABC1234.TXNIN',3,1);
  assert.equal(calls.length,2);
  assert.equal(calls[0]?.[3],'Z73968.UABC1234.TXNIN');
  assert.equal(calls[1]?.[2],'data-set-sequential');
  assert.equal(calls[1]?.includes('--rfj'),true);
  assert.equal(calls[1]?.includes('--user'),false);
});

test('rejects dataset responses that omit the exact requested resource or valid attributes', async () => {
  const adapter = createZoweUploadAdapter({ platform:'win32', env:{ PATH:'C:\\zowe' }, locate:async()=> 'zowe.cmd', invoke:async()=>({ exitCode:0, stdout:JSON.stringify({ success:true, exitCode:0, data:{ success:true, apiResponse:{ items:[{dsname:'Z73968.UNRELATED.DATA',dsorg:'PS',recfm:'FB',lrecl:38}] } } }), stderr:'' }) });
  await assert.rejects(()=>adapter.attributes('Z73968.UABC1234.TXNIN'),/did not verify|not returned/);
});
