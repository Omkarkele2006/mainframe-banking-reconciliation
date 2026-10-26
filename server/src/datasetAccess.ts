import { datasetMatchesScope, validDatasetScope } from './zoweCli.js';

export function resolveDatasetReadScopes(config: { MAINFRAME_HLQ?: string; MAINFRAME_DATASET_READ_SCOPES?: string }): string[] {
  const hlq=(config.MAINFRAME_HLQ??'').trim().toUpperCase();
  if(hlq!=='Z73968'||!/^[A-Z#$@][A-Z0-9#$@]{0,7}(?:\.[A-Z#$@][A-Z0-9#$@]{0,7})*$/.test(hlq))return [];
  return [...new Set((config.MAINFRAME_DATASET_READ_SCOPES??'').split(',').map((value)=>value.trim().toUpperCase()).filter((scope)=>{
    if(!validDatasetScope(scope,hlq))return false;
    const prefix=scope.slice(0,-2);
    return prefix===hlq||prefix.startsWith(`${hlq}.`);
  }))];
}

export function datasetAllowedForRead(dataset:string,scope:string,config:{MAINFRAME_HLQ?:string;MAINFRAME_DATASET_READ_SCOPES?:string}):boolean {
  return resolveDatasetReadScopes(config).includes(scope.trim().toUpperCase())&&datasetMatchesScope(dataset,scope);
}
