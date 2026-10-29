import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeTenKDemoInputs} from '../src/demoFixtures.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../test-data/demo-10k');
const files=new Map<string,Buffer>();
for(const negative of [false,true]){
  const inputs=makeTenKDemoInputs(negative),prefix=negative?'negative':'positive';
  files.set(`${prefix}-transactions.txt`,inputs.transaction);
  files.set(`${prefix}-settlements.txt`,inputs.settlement);
}
await fs.mkdir(root,{recursive:true});
for(const name of files.keys()){
  try{await fs.access(path.join(root,name));throw new Error(`Refusing to replace existing fixture: ${name}`);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
for(const [name,bytes] of files)await fs.writeFile(path.join(root,name),bytes,{flag:'wx'});
console.log(`Created four local 10K input fixtures in ${root}. No mainframe operations performed.`);
