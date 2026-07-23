const P='/home/claude/trading/packages/shared/src';
const { detectSwings } = require(P+'/live-engine/swings');
const LIVE = require(P+'/live-engine/config');
const days=[['/tmp/s2.json','15Jul'],['/tmp/s3.json','16Jul'],['/tmp/s4.json','19Jul'],['/tmp/s5.json','20Jul'],['/tmp/s6.json','21Jul']];

// For every minute where a fib signal fires on a Lane-A stock, measure the forward move.
// Compare against RANDOM entries on the same stocks/minutes. If the signal has edge, its
// forward distribution must beat random. If it matches random, the signal is noise and no
// amount of exit tuning can rescue it.
const sig={conf:[],zone:[]}, rnd=[];
let rng=12345; const rand=()=>((rng=(rng*1103515245+12345)&0x7fffffff)/0x7fffffff);

for (const [f,l] of days){
  const s=require(f);
  for (const [sym,d] of Object.entries(s.symbols)){
    if (!d.cls || !LIVE.HISTORY.qualifyLanes.includes(d.cls.lane)) continue;
    const rows=d.rows.filter(r=>r.price>0);
    if (rows.length<60) continue;
    const px=rows.map(r=>r.price);
    const fwd=(i,n)=>{ const seg=px.slice(i+1,i+1+n); return seg.length? {mfe:Math.max(...seg)-px[i], mae:Math.min(...seg)-px[i], end:seg[seg.length-1]-px[i]} : null; };
    for (let i=20;i<px.length-60;i++){
      const w=rows.slice(Math.max(0,i-LIVE.WINDOW.snapshots+1),i+1).map(r=>({price:r.price,ts:r.ts}));
      const sw=detectSwings(w, LIVE.SWING);
      if (!sw.fib) continue;
      const f30=fwd(i,30); if(!f30) continue;
      if (sw.secondSwingStarting) sig.conf.push(f30);
      else if (sw.pullbackHeldFib && px[i]>=sw.fib.zoneLow && px[i]<=sw.fib.zoneHigh) sig.zone.push(f30);
      if (rand()<0.02) rnd.push(f30);   // random control on the same universe
    }
  }
}
const stat=(a,name)=>{
  if(!a.length){console.log(name,'no samples');return;}
  const m=k=>Math.round(a.reduce((s,x)=>s+x[k],0)/a.length*100)/100;
  const pctUp=Math.round(100*a.filter(x=>x.end>0).length/a.length);
  const pMfe5=Math.round(100*a.filter(x=>x.mfe>=5).length/a.length);
  console.log(name.padEnd(26), String(a.length).padStart(6),
    String(m('mfe')).padStart(8), String(m('mae')).padStart(8), String(m('end')).padStart(8),
    String(pctUp+'%').padStart(7), String(pMfe5+'%').padStart(8));
};
console.log('Forward 30 minutes after each event, Lane-A stocks, 5 days\n');
console.log('event'.padEnd(26),'n'.padStart(6),'avgMFE'.padStart(8),'avgMAE'.padStart(8),'avgEND'.padStart(8),'%up'.padStart(7),'%MFE>=5f'.padStart(8));
console.log('-'.repeat(76));
stat(sig.conf,'fib 2nd-swing confirm');
stat(sig.zone,'fib pullback zone');
stat(rnd,'RANDOM (control)');
