/** Deterministic demo INPUTS only; expected outcomes are fixture specifications,
 * never reconciliation results. Actual matching remains on z/OS. */
export function makeTenKDemoInputs(negative=false){
  const transaction=Array.from({length:10000},(_,index)=>`${String(index+1).padStart(10,'0')}ACCOUNT00100000125020261028A`);
  const settlement=transaction.map((row,index)=>negative&&index<10?`${row.slice(0,20)}000001251${row.slice(29)}`:row);
  const bytes=(records:string[])=>Buffer.from(`${records.join('\r\n')}\r\n`,'ascii');
  return {transaction:bytes(transaction),settlement:bytes(settlement)};
}
