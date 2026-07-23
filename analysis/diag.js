const P='/home/claude/trading/packages/shared/src';
const {run}=require(P+'/replay/harness');
const CFG=require(P+'/tmi/config');
const LIQ=require(P+'/live-engine/config').LIQUIDITY, COMM=require(P+'/live-engine/config').COMMISSION;
const days=[['/tmp/s1.json','15Jul'],['/tmp/s2.json','16Jul'],['/tmp/s3.json','19Jul'],['/tmp/s4.json','20Jul'],['/tmp/s5.json','21Jul']];

// For every entry the engine actually made: what was the best and worst the price got
// in the following 60 minutes? MFE = max favourable excursion, MAE = max adverse.
// If MFE is small, the ENTRIES are bad. If MFE is large but net is negative, the EXITS are.
let rows=[];
for (const [f,l] of days){
  const s=require(f);
  const {contracts}=run(s,CFG,LIQ,COMM);
  for (const c of contracts){
    if (c.buyPrice==null) continue;
    const path=s.symbols[c.symbol].rows.filter(r=>r.minute>c.buyMinute && r.minute<=c.buyMinute+60 && r.price>0).map(r=>r.price);
    if (!path.length) continue;
    const mfe=Math.max(...path)-c.buyPrice, mae=Math.min(...path)-c.buyPrice;
    rows.push({day:l,sym:c.symbol,buy:c.buyPrice,shares:c.shares,target:c.target,stop:c.stop,
      mfe,mae,net:c.netKd,exit:c.exitReason});
  }
}
const n=rows.length;
const avg=(k)=>Math.round(rows.reduce((a,r)=>a+r[k],0)/n*10)/10;
console.log(`entries analysed: ${n}\n`);
console.log('MFE = best the price got within 60 min of entry (fils)');
console.log('MAE = worst it got\n');
console.log('  avg MFE  ', avg('mfe'), 'f     avg MAE ', avg('mae'), 'f     avg target ', avg('target'), 'f     avg stop ', avg('stop'), 'f');
const hitTarget=rows.filter(r=>r.mfe>=r.target).length;
const hitStopFirst=rows.filter(r=>r.mae<=-r.stop).length;
console.log(`\n  reached target at some point : ${hitTarget}/${n}  (${Math.round(100*hitTarget/n)}%)`);
console.log(`  went stop-distance against   : ${hitStopFirst}/${n}  (${Math.round(100*hitStopFirst/n)}%)`);
console.log(`  MFE > 0 (ever green)         : ${rows.filter(r=>r.mfe>0).length}/${n}`);
console.log(`  MFE >= 5f                    : ${rows.filter(r=>r.mfe>=5).length}/${n}`);

// perfect-exit ceiling: if we sold at the best price within 60 min
let perf=0, actual=0;
for(const r of rows){
  const comm=Math.max(0.5,0.0015*r.buy*r.shares/1000)*2;
  perf += (r.mfe*r.shares)/1000 - comm;
  actual += r.net;
}
console.log(`\n  actual net across all 5 days      : ${Math.round(actual*10)/10} KD`);
console.log(`  PERFECT-EXIT ceiling (sell at MFE): ${Math.round(perf*10)/10} KD`);
console.log('\nworst 8 entries:');
rows.sort((a,b)=>a.net-b.net).slice(0,8).forEach(r=>
  console.log(`  ${r.day} ${r.sym.padEnd(10)} buy ${String(r.buy).padStart(5)} ${String(r.shares).padStart(6)}sh  MFE ${String(Math.round(r.mfe)).padStart(4)}f MAE ${String(Math.round(r.mae)).padStart(4)}f  net ${String(r.net).padStart(8)} ${r.exit}`));
