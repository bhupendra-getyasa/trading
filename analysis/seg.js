const P='/home/claude/trading/packages/shared/src';
const { detectSwings } = require(P+'/live-engine/swings');
const { buildBook } = require(P+'/live-engine/liquidity');
const LIVE = require(P+'/live-engine/config');
const days=[['/tmp/s2.json'],['/tmp/s3.json'],['/tmp/s4.json'],['/tmp/s5.json'],['/tmp/s6.json']];
const rec=[];
for (const [f] of days){
  const s=require(f);
  for (const [sym,d] of Object.entries(s.symbols)){
    if (!d.cls || !LIVE.HISTORY.qualifyLanes.includes(d.cls.lane)) continue;
    const rows=d.rows.filter(r=>r.price>0); if(rows.length<80) continue;
    const px=rows.map(r=>r.price);
    for (let i=20;i<px.length-30;i++){
      const w=rows.slice(Math.max(0,i-19),i+1);
      const sw=detectSwings(w.map(r=>({price:r.price,ts:r.ts})), LIVE.SWING);
      if (!sw.fib||!sw.pullbackHeldFib) continue;
      if (!(px[i]>=sw.fib.zoneLow && px[i]<=sw.fib.zoneHigh)) continue;
      const book=buildBook(w.map(r=>r.raw), LIVE.LIQUIDITY, w[w.length-1].ts);
      const seg=px.slice(i+1,i+31);
      rec.push({ swing1:sw.swing1Fils||0, price:px[i], minute:rows[i].minute,
        tpm:book.tradesPerMin, depth:book.medBidQty, spread:book.medSpreadFils,
        end:seg[seg.length-1]-px[i], mfe:Math.max(...seg)-px[i], mae:Math.min(...seg)-px[i] });
    }
  }
}
console.log(`zone signals: ${rec.length}\n`);
function seg(name, filt){
  const a=rec.filter(filt); if(a.length<25) return;
  const m=k=>Math.round(a.reduce((s,x)=>s+x[k],0)/a.length*100)/100;
  const up=Math.round(100*a.filter(x=>x.end>0).length/a.length);
  const big=Math.round(100*a.filter(x=>x.mfe>=5).length/a.length);
  console.log(name.padEnd(30), String(a.length).padStart(6), String(m('end')).padStart(8),
    String(m('mfe')).padStart(7), String(m('mae')).padStart(7), String(up+'%').padStart(6), String(big+'%').padStart(8));
}
console.log('segment'.padEnd(30),'n'.padStart(6),'avgEND'.padStart(8),'MFE'.padStart(7),'MAE'.padStart(7),'%up'.padStart(6),'MFE>=5f'.padStart(8));
console.log('-'.repeat(80));
seg('ALL zone signals', ()=>true);
console.log('-- by swing1 size --');
seg('swing1 3-4f', r=>r.swing1>=3&&r.swing1<5);
seg('swing1 5-7f', r=>r.swing1>=5&&r.swing1<8);
seg('swing1 8-12f', r=>r.swing1>=8&&r.swing1<13);
seg('swing1 >=13f', r=>r.swing1>=13);
console.log('-- by trade activity --');
seg('tpm < 1', r=>r.tpm!=null&&r.tpm<1);
seg('tpm 1-3', r=>r.tpm!=null&&r.tpm>=1&&r.tpm<3);
seg('tpm 3-8', r=>r.tpm!=null&&r.tpm>=3&&r.tpm<8);
seg('tpm >= 8', r=>r.tpm!=null&&r.tpm>=8);
console.log('-- by time of day --');
seg('first 30 min', r=>r.minute<30);
seg('30-90 min', r=>r.minute>=30&&r.minute<90);
seg('90-180 min', r=>r.minute>=90&&r.minute<180);
seg('180+ min', r=>r.minute>=180);
console.log('-- combined best guess --');
seg('swing1>=8 & tpm>=3', r=>r.swing1>=8&&r.tpm>=3);
seg('swing1>=8 & tpm>=3 & m>=30', r=>r.swing1>=8&&r.tpm>=3&&r.minute>=30);
