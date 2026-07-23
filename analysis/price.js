const P='/home/claude/trading/packages/shared/src';
const { detectSwings } = require(P+'/live-engine/swings');
const { buildBook } = require(P+'/live-engine/liquidity');
const LIVE = require(P+'/live-engine/config');
const days=['/tmp/s2.json','/tmp/s3.json','/tmp/s4.json','/tmp/s5.json','/tmp/s6.json'];
const rec=[];
for (const f of days){
  const s=require(f);
  for (const [sym,d] of Object.entries(s.symbols)){
    if (!d.cls || !LIVE.HISTORY.qualifyLanes.includes(d.cls.lane)) continue;
    const rows=d.rows.filter(r=>r.price>0); if(rows.length<80) continue;
    const px=rows.map(r=>r.price);
    for (let i=20;i<px.length-30;i++){
      const w=rows.slice(i-19,i+1);
      const sw=detectSwings(w.map(r=>({price:r.price,ts:r.ts})), LIVE.SWING);
      if (!sw.fib||!sw.pullbackHeldFib) continue;
      if (!(px[i]>=sw.fib.zoneLow && px[i]<=sw.fib.zoneHigh)) continue;
      const book=buildBook(w.map(r=>r.raw), LIVE.LIQUIDITY, w[w.length-1].ts);
      const seg=px.slice(i+1,i+31);
      rec.push({price:px[i],swing1:sw.swing1Fils||0,depth:book.medBidQty,
        end:seg[seg.length-1]-px[i], mfe:Math.max(...seg)-px[i]});
    }
  }
}
console.log('THE KEY RATIO: the signal edge is roughly CONSTANT in fils,');
console.log('but commission is 0.30% of PRICE — so it grows with the share price.\n');
console.log('price band'.padEnd(16),'n'.padStart(6),'avgEND'.padStart(8),'comm(fils)'.padStart(11),'EDGE-COST'.padStart(11),'verdict'.padStart(10));
console.log('-'.repeat(70));
const bands=[[0,100],[100,150],[150,230],[230,350],[350,600],[600,9999]];
for(const [lo,hi] of bands){
  const a=rec.filter(r=>r.price>=lo&&r.price<hi);
  if(a.length<20) continue;
  const end=a.reduce((s,x)=>s+x.end,0)/a.length;
  const avgP=a.reduce((s,x)=>s+x.price,0)/a.length;
  const commFils=avgP*0.003;                       // 0.15% x 2 sides, in fils
  const net=end-commFils;
  console.log(`${lo}-${hi===9999?'+':hi} fils`.padEnd(16), String(a.length).padStart(6),
    String(Math.round(end*100)/100).padStart(8), String(Math.round(commFils*100)/100).padStart(11),
    String(Math.round(net*100)/100).padStart(11), (net>0?'VIABLE':'loses').padStart(10));
}
console.log('\nbreak-even price = edge / 0.003 :');
const allEnd=rec.reduce((s,x)=>s+x.end,0)/rec.length;
console.log(`  overall edge ${Math.round(allEnd*100)/100}f  ->  only stocks under ~${Math.round(allEnd/0.003)} fils can clear commission`);
